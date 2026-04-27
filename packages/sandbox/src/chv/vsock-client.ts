// vsock command/response client.
//
// The brainstorm-agent host process opens an AF_UNIX socket created by
// Cloud Hypervisor's `--vsock cid=N,socket=/path` flag. Cloud Hypervisor
// exposes a bridge protocol on that socket: the host writes
// `CONNECT <port>\n` (ASCII), CHV replies with `OK <sourcePort>\n` on
// success or any other line on failure. After a successful CONNECT, the
// AF_UNIX socket is a transparent byte stream to the in-guest vsock
// listener on `<port>`.
//
// Once connected, we speak a length-prefixed JSON-frame protocol:
//
//   uint32 BE length | JSON bytes (UTF-8) of exactly `length` bytes
//
// Every request and response carries a `request_id` (UUID-shaped string)
// so one connection can have many in-flight requests. The host maintains
// a `request_id` -> pending-resolver map; the read loop dispatches each
// inbound frame back to the matching resolver.
//
// Message kinds (per docs/endpoint-agent-protocol-v1.md section 6):
//
//   - ToolDispatch    (host -> guest)  - execute a tool
//   - ToolResult      (guest -> host)  - terminal result for a ToolDispatch
//   - GuestQuery      (host -> guest)  - integrity-monitor probe (fd count etc.)
//   - GuestResponse   (guest -> host)  - response to GuestQuery
//
// Wire-level `request_id` is mapped onto the protocol's existing
// `command_id` (for ToolDispatch / ToolResult) and `query_id` (for
// GuestQuery / GuestResponse). The on-the-wire schema matches the
// protocol doc exactly; this client only injects the length prefix.
//
// Darwin: Cloud Hypervisor doesn't run on Darwin, so when no AF_UNIX
// socket exists at the configured path we throw `SandboxNotAvailableError`
// to keep the local typecheck/build path friendly. If a socket DOES exist
// at that path (e.g. a fake CHV-like listener stood up by tests), we go
// through the real protocol -- that's how the test suite exercises this
// file on Darwin.

import { connect, type Socket } from "node:net";
import { stat } from "node:fs/promises";
import { platform as nodePlatform } from "node:process";
import { randomUUID } from "node:crypto";

import {
  SandboxError,
  SandboxNotAvailableError,
  SandboxToolTimeoutError,
  SandboxVsockFrameTooLargeError,
  SandboxVsockHandshakeError,
} from "../errors.js";
import type { ToolExecution, ToolInvocation } from "../sandbox.js";

/** Default 16 MiB cap, matches protocol section 6 ("Max frame size 16 MiB"). */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Default vsock guest port for the in-guest dispatcher. */
export const DEFAULT_GUEST_PORT = 1024;

/** Protocol §6: connection-level timeout when a frame is mid-flight (after
 *  4-byte length header but before full payload arrives). Fires fatal. */
export const DEFAULT_PARTIAL_FRAME_TIMEOUT_MS = 30_000;

export interface VsockClientOptions {
  /** Host-side AF_UNIX path that CHV created via `--vsock socket=...`. */
  socketPath: string;
  /** Guest port the in-guest dispatcher is listening on. Default 1024. */
  guestPort?: number;
  /** Max declared frame length in bytes. Default 16 MiB. */
  maxFrameBytes?: number;
  /** Handshake timeout in ms. Default 5_000. */
  handshakeTimeoutMs?: number;
  /** Partial-frame stall timeout (protocol §6). Default 30_000. */
  partialFrameTimeoutMs?: number;
  logger?: { info: (m: string) => void; error: (m: string) => void };
}

/** GuestQuery kinds defined in protocol section 6.3.5. */
export type GuestQueryKind = "OpenFdCount" | "MemUsage" | "ProcessList";

export type GuestQueryResult =
  | { open_fd_count: number }
  | { bytes_used: number; bytes_total: number }
  | { processes: Array<{ name: string; pid: number }> };

interface PendingRequest {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  /** Set if a deadline timer is pending so we can cancel it on response. */
  timer: NodeJS.Timeout | null;
}

/** Internal: parse a `CONNECT` reply line. */
function parseHandshakeReply(
  line: string,
): { ok: true; sourcePort: number } | { ok: false; raw: string } {
  // CHV writes `OK <port>\n`. Anything else (commonly an empty line, or
  // the connection is closed) is a failure.
  const trimmed = line.replace(/\r?\n$/, "");
  const m = /^OK\s+(\d+)$/.exec(trimmed);
  if (m === null) {
    return { ok: false, raw: trimmed };
  }
  const sourcePort = Number.parseInt(m[1], 10);
  if (!Number.isFinite(sourcePort) || sourcePort < 0) {
    return { ok: false, raw: trimmed };
  }
  return { ok: true, sourcePort };
}

/** Internal: incremental read state. The socket is a byte stream so we
 *  may receive partial frames or several frames glued together. */
interface ReadState {
  buf: Buffer;
  /** When we have a length header but not enough payload yet. */
  expecting: number | null;
}

export class VsockClient {
  private readonly opts: Required<
    Pick<
      VsockClientOptions,
      | "guestPort"
      | "maxFrameBytes"
      | "handshakeTimeoutMs"
      | "partialFrameTimeoutMs"
    >
  > &
    VsockClientOptions;
  private readonly logger: NonNullable<VsockClientOptions["logger"]>;
  private socket: Socket | null = null;
  private sourcePort: number | null = null;
  private readState: ReadState = { buf: Buffer.alloc(0), expecting: null };
  private readonly pending = new Map<string, PendingRequest>();
  /** True once the read loop has been attached. */
  private readLoopAttached = false;
  /** Latched fatal error -- once set, all in-flight + future ops fail with it. */
  private fatal: Error | null = null;
  /** Watchdog: armed whenever we're mid-frame (expecting !== null) and
   *  haven't made progress for partialFrameTimeoutMs. Protocol §6 mandates
   *  a 30s connection-level partial-frame timeout independent of any
   *  per-request deadline. Fires SandboxVsockPartialFrameTimeoutError. */
  private partialFrameTimer: NodeJS.Timeout | null = null;

  constructor(opts: VsockClientOptions) {
    this.opts = {
      guestPort: opts.guestPort ?? DEFAULT_GUEST_PORT,
      maxFrameBytes: opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 5_000,
      partialFrameTimeoutMs:
        opts.partialFrameTimeoutMs ?? DEFAULT_PARTIAL_FRAME_TIMEOUT_MS,
      ...opts,
    };
    this.logger = opts.logger ?? {
      info: () => {},
      error: () => {},
    };
  }

  /**
   * Connect to the AF_UNIX socket and perform the CHV `CONNECT <port>`
   * handshake. After this resolves, the socket is a transparent byte
   * stream into the guest's vsock listener and `sendCommand` /
   * `dispatchRequest` / `guestQuery` are usable.
   *
   * Darwin: if no socket file exists at `socketPath`, throws
   * `SandboxNotAvailableError`. If a socket DOES exist (tests stand up a
   * fake listener), the full protocol is exercised -- useful for unit
   * tests of this file's own behaviour.
   */
  async open(): Promise<void> {
    if (this.socket !== null) return;

    // Darwin honesty rail: if there's no socket file, surface
    // SandboxNotAvailableError rather than letting `connect` produce a
    // confusing ENOENT. We deliberately check by `stat` rather than
    // platform alone -- a fake AF_UNIX listener (in tests) on Darwin
    // exists at `socketPath` and SHOULD go through the real path.
    if (nodePlatform === "darwin") {
      try {
        await stat(this.opts.socketPath);
      } catch {
        throw new SandboxNotAvailableError(
          `Cloud Hypervisor vsock socket not present at ${this.opts.socketPath} ` +
            `(Darwin host; CHV cannot run here). On Linux this socket is ` +
            `created by the --vsock cid=N,socket=... flag at boot.`,
        );
      }
    }

    const sock = await this.connectSocket();

    try {
      this.sourcePort = await this.handshake(sock);
    } catch (e) {
      try {
        sock.destroy();
      } catch {}
      throw e;
    }

    this.socket = sock;
    this.attachReadLoop();
    this.logger.info(
      `[vsock] handshake ok: connected to guest port ${this.opts.guestPort} as source ${this.sourcePort}`,
    );
  }

  private connectSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.opts.socketPath);
      const onError = (err: Error) => {
        sock.removeListener("connect", onConnect);
        reject(
          new SandboxNotAvailableError(
            `vsock socket not reachable at ${this.opts.socketPath}: ${err.message}`,
            err,
          ),
        );
      };
      const onConnect = () => {
        sock.removeListener("error", onError);
        resolve(sock);
      };
      sock.once("error", onError);
      sock.once("connect", onConnect);
    });
  }

  private handshake(sock: Socket): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let acc = Buffer.alloc(0);
      let settled = false;

      const cleanup = () => {
        sock.removeListener("data", onData);
        sock.removeListener("error", onError);
        sock.removeListener("close", onClose);
        clearTimeout(timer);
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const succeed = (port: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        // If extra bytes arrived past the newline they're frames for the
        // length-prefixed protocol -- push them into the read state so
        // the read loop picks them up.
        const nlIdx = acc.indexOf(0x0a);
        if (nlIdx !== -1 && nlIdx + 1 < acc.length) {
          this.readState.buf = Buffer.concat([
            this.readState.buf,
            acc.subarray(nlIdx + 1),
          ]);
        }
        resolve(port);
      };

      const onData = (chunk: Buffer) => {
        acc = Buffer.concat([acc, chunk]);
        const nlIdx = acc.indexOf(0x0a);
        if (nlIdx === -1) {
          // No newline yet -- may be a partial reply; keep buffering.
          // Guard against runaway: 256 bytes is generous for `OK <port>\n`.
          if (acc.length > 256) {
            fail(
              new SandboxVsockHandshakeError(
                `handshake reply exceeded 256 bytes without a newline`,
              ),
            );
          }
          return;
        }
        const line = acc.subarray(0, nlIdx).toString("ascii");
        const parsed = parseHandshakeReply(line + "\n");
        if (!parsed.ok) {
          fail(
            new SandboxVsockHandshakeError(
              `unexpected handshake reply from CHV: ${JSON.stringify(parsed.raw)}`,
            ),
          );
          return;
        }
        succeed(parsed.sourcePort);
      };

      const onError = (err: Error) => {
        fail(
          new SandboxVsockHandshakeError(
            `socket error during handshake: ${err.message}`,
            err,
          ),
        );
      };

      const onClose = () => {
        fail(
          new SandboxVsockHandshakeError(
            `socket closed during handshake (peer hung up before sending OK)`,
          ),
        );
      };

      const timer = setTimeout(() => {
        fail(
          new SandboxVsockHandshakeError(
            `handshake timed out after ${this.opts.handshakeTimeoutMs}ms`,
          ),
        );
      }, this.opts.handshakeTimeoutMs);

      sock.on("data", onData);
      sock.once("error", onError);
      sock.once("close", onClose);

      // Send the CONNECT line. CHV expects ASCII; we follow the
      // documented form exactly: "CONNECT <port>\n".
      sock.write(`CONNECT ${this.opts.guestPort}\n`, "ascii", (err) => {
        if (err !== null && err !== undefined) {
          fail(
            new SandboxVsockHandshakeError(
              `failed to write CONNECT: ${err.message}`,
              err,
            ),
          );
        }
      });
    });
  }

  /**
   * Wire up the long-running read loop on `this.socket`. Demuxes inbound
   * length-prefixed JSON frames back to pending `request_id` resolvers.
   */
  private attachReadLoop(): void {
    if (this.readLoopAttached || this.socket === null) return;
    this.readLoopAttached = true;
    const sock = this.socket;

    sock.on("data", (chunk: Buffer) => {
      this.readState.buf = Buffer.concat([this.readState.buf, chunk]);
      // Bytes arrived: if a frame was mid-flight, kick the partial-frame
      // watchdog forward. drainFrames() will (re-)arm or clear it based
      // on the post-drain state.
      this.drainFrames();
    });
    sock.once("error", (err) => {
      this.fail(err);
    });
    sock.once("close", () => {
      this.fail(new SandboxError("SANDBOX_VSOCK_CLOSED", "vsock closed"));
    });

    // The socket may already have buffered post-handshake bytes (from
    // `succeed` above pushing them into readState).
    if (this.readState.buf.length > 0) {
      this.drainFrames();
    }
  }

  private drainFrames(): void {
    while (true) {
      if (this.fatal !== null) return;
      if (this.readState.expecting === null) {
        if (this.readState.buf.length < 4) {
          // Between frames OR mid-header. If we have 1-3 header bytes,
          // arm/refresh the partial-frame watchdog (peer started a frame
          // but stalled). Otherwise (buf empty), ensure the watchdog is
          // cleared.
          if (this.readState.buf.length === 0) {
            this.clearPartialFrameWatchdog();
          } else {
            this.armPartialFrameWatchdog();
          }
          return;
        }
        const declared = this.readState.buf.readUInt32BE(0);
        if (declared > this.opts.maxFrameBytes) {
          // Latched fatal; we cannot safely skip past `declared` bytes
          // from a peer that may be lying.
          this.fail(
            new SandboxVsockFrameTooLargeError(
              declared,
              this.opts.maxFrameBytes,
            ),
          );
          return;
        }
        this.readState.expecting = declared;
        this.readState.buf = this.readState.buf.subarray(4);
      }
      if (this.readState.buf.length < this.readState.expecting) {
        // Header in hand, payload incomplete: arm/refresh watchdog. Each
        // call to drainFrames after new data refreshes the deadline, so
        // a peer dripping bytes faster than partialFrameTimeoutMs stays
        // alive while a fully stalled peer trips the timeout.
        this.armPartialFrameWatchdog();
        return;
      }
      const payload = this.readState.buf.subarray(0, this.readState.expecting);
      this.readState.buf = this.readState.buf.subarray(
        this.readState.expecting,
      );
      this.readState.expecting = null;
      this.clearPartialFrameWatchdog();
      this.handleFrame(payload);
    }
  }

  private armPartialFrameWatchdog(): void {
    if (this.partialFrameTimer !== null) {
      clearTimeout(this.partialFrameTimer);
    }
    this.partialFrameTimer = setTimeout(() => {
      this.partialFrameTimer = null;
      this.fail(
        new SandboxError(
          "SANDBOX_VSOCK_PARTIAL_FRAME_TIMEOUT",
          `vsock partial frame stalled for >${this.opts.partialFrameTimeoutMs}ms (protocol §6 connection-level timeout)`,
        ),
      );
    }, this.opts.partialFrameTimeoutMs);
  }

  private clearPartialFrameWatchdog(): void {
    if (this.partialFrameTimer !== null) {
      clearTimeout(this.partialFrameTimer);
      this.partialFrameTimer = null;
    }
  }

  private handleFrame(payload: Buffer): void {
    let frame: Record<string, unknown>;
    try {
      const text = payload.toString("utf-8");
      const parsed = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("frame is not a JSON object");
      }
      frame = parsed as Record<string, unknown>;
    } catch (e) {
      this.logger.error(
        `[vsock] dropping malformed frame: ${(e as Error).message}`,
      );
      return;
    }

    // request_id is the unifying correlator. ToolResult uses `command_id`,
    // GuestResponse uses `query_id`. We accept any of those keys as the
    // correlator field.
    const requestId =
      (typeof frame.request_id === "string" && frame.request_id) ||
      (typeof frame.command_id === "string" && frame.command_id) ||
      (typeof frame.query_id === "string" && frame.query_id) ||
      null;
    if (requestId === null) {
      this.logger.error(
        `[vsock] dropping frame with no request_id/command_id/query_id`,
      );
      return;
    }
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      this.logger.error(
        `[vsock] late_arrival: response for unknown request_id=${requestId}`,
      );
      return;
    }
    this.pending.delete(requestId);
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.resolve(frame);
  }

  private fail(err: Error): void {
    if (this.fatal !== null) return;
    this.fatal = err;
    this.clearPartialFrameWatchdog();
    for (const [, p] of this.pending) {
      if (p.timer !== null) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (this.socket !== null) {
      try {
        this.socket.destroy();
      } catch {}
    }
  }

  /**
   * Send a length-prefixed JSON request and await the matching reply.
   * Multiple requests may be in flight; correlation is by `request_id`.
   * Throws `SandboxToolTimeoutError` on deadline expiry.
   */
  private async sendFrame<T extends Record<string, unknown>>(
    requestId: string,
    frame: Record<string, unknown>,
    deadlineMs: number,
  ): Promise<T> {
    if (this.fatal !== null) throw this.fatal;
    if (this.socket === null) {
      throw new SandboxNotAvailableError("vsock not open");
    }
    if (this.pending.has(requestId)) {
      throw new SandboxError(
        "SANDBOX_VSOCK_DUPLICATE_REQUEST",
        `duplicate inflight request_id=${requestId}`,
      );
    }

    const json = Buffer.from(JSON.stringify(frame), "utf-8");
    if (json.length > this.opts.maxFrameBytes) {
      throw new SandboxVsockFrameTooLargeError(
        json.length,
        this.opts.maxFrameBytes,
        `outbound frame ${json.length} bytes exceeds local cap ${this.opts.maxFrameBytes}`,
      );
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(json.length, 0);
    // Concatenate header + payload into a SINGLE write call. Two
    // separate `sock.write(...)`s interleave on the wire when multiple
    // requests are in flight (Promise.all([send, send]) issues both
    // headers before either payload), corrupting the framing.
    const wireBytes = Buffer.concat([header, json]);

    const responsePromise = new Promise<T>((resolve, reject) => {
      const timer =
        deadlineMs > 0
          ? setTimeout(() => {
              if (this.pending.delete(requestId)) {
                reject(
                  new SandboxToolTimeoutError(
                    deadlineMs,
                    `vsock request ${requestId} exceeded deadline ${deadlineMs}ms`,
                  ),
                );
              }
            }, deadlineMs)
          : null;
      this.pending.set(requestId, {
        resolve: (f) => resolve(f as T),
        reject,
        timer,
      });
    });

    const sock = this.socket;
    await new Promise<void>((resolve, reject) => {
      sock.write(wireBytes, (err) => {
        if (err !== null && err !== undefined) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    return responsePromise;
  }

  /**
   * Public surface for ToolDispatch (host -> guest) -> ToolResult (guest -> host).
   * Maps a `ToolInvocation` onto the wire format and unpacks the reply
   * into a `ToolExecution`. Used by `ChvSandbox.executeTool`.
   */
  async sendCommand(invocation: ToolInvocation): Promise<ToolExecution> {
    return this.dispatchRequest(invocation);
  }

  /** Same as `sendCommand`, named to match the protocol's verb. */
  async dispatchRequest(invocation: ToolInvocation): Promise<ToolExecution> {
    const frame: Record<string, unknown> = {
      type: "ToolDispatch",
      command_id: invocation.command_id,
      tool: invocation.tool,
      params: invocation.params,
      deadline_ms: invocation.deadline_ms,
    };
    const reply = await this.sendFrame<Record<string, unknown>>(
      invocation.command_id,
      frame,
      invocation.deadline_ms,
    );
    if (reply.type !== "ToolResult") {
      throw new SandboxError(
        "SANDBOX_VSOCK_PROTOCOL_ERROR",
        `expected ToolResult, got ${JSON.stringify(reply.type)}`,
      );
    }
    const exit_code =
      typeof reply.exit_code === "number" ? reply.exit_code : -1;
    const stdout = typeof reply.stdout === "string" ? reply.stdout : "";
    const stderr = typeof reply.stderr === "string" ? reply.stderr : "";
    const evidence_hash =
      typeof reply.evidence_hash === "string" ? reply.evidence_hash : undefined;
    return { exit_code, stdout, stderr, evidence_hash };
  }

  /**
   * Public surface for the integrity monitor's GuestQuery (host -> guest)
   * -> GuestResponse (guest -> host) round trip. Returns the raw `result`
   * payload from section 6.3.6.
   */
  async guestQuery(
    kind: GuestQueryKind,
    opts: { timeoutMs?: number; queryId?: string } = {},
  ): Promise<GuestQueryResult> {
    // Per section 6.3.5 timeout: 1s for OpenFdCount/MemUsage; 5s for ProcessList.
    const defaultTimeout = kind === "ProcessList" ? 5_000 : 1_000;
    const queryId = opts.queryId ?? randomUUID();
    const frame: Record<string, unknown> = {
      type: "GuestQuery",
      query_id: queryId,
      query_kind: kind,
      ts: new Date().toISOString(),
    };
    const reply = await this.sendFrame<Record<string, unknown>>(
      queryId,
      frame,
      opts.timeoutMs ?? defaultTimeout,
    );
    if (reply.type !== "GuestResponse") {
      throw new SandboxError(
        "SANDBOX_VSOCK_PROTOCOL_ERROR",
        `expected GuestResponse, got ${JSON.stringify(reply.type)}`,
      );
    }
    if (
      reply.result === null ||
      typeof reply.result !== "object" ||
      Array.isArray(reply.result)
    ) {
      throw new SandboxError(
        "SANDBOX_VSOCK_PROTOCOL_ERROR",
        `GuestResponse missing result object`,
      );
    }
    return reply.result as GuestQueryResult;
  }

  /** True once `open()` has succeeded and no fatal error has been latched. */
  isOpen(): boolean {
    return this.socket !== null && this.fatal === null;
  }

  /** Source port assigned by CHV during the CONNECT handshake. */
  getSourcePort(): number | null {
    return this.sourcePort;
  }

  async close(): Promise<void> {
    if (this.socket === null) return;
    const sock = this.socket;
    this.socket = null;
    // Reject any still-pending requests with a clear error.
    if (this.fatal === null) {
      this.fail(
        new SandboxError("SANDBOX_VSOCK_CLOSED", "vsock closed by host"),
      );
    }
    await new Promise<void>((resolve) => {
      sock.end(() => resolve());
      // end() may not fire 'finish' if the peer is already gone; cap
      // ourselves at 250ms then destroy.
      setTimeout(() => {
        try {
          sock.destroy();
        } catch {}
        resolve();
      }, 250).unref();
    });
  }
}
