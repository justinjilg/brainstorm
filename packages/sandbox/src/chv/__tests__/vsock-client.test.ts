// Tests for VsockClient against an in-process AF_UNIX server that mimics
// Cloud Hypervisor's vsock bridge protocol.
//
// What's covered (and what's NOT):
//   - Happy path: CONNECT/OK handshake, ToolDispatch -> ToolResult, GuestQuery
//     -> GuestResponse, multiple in-flight requests demuxed by request_id.
//   - Sad paths: bad handshake reply, peer hangs up mid-handshake, frame
//     larger than the cap, malformed JSON frame (silently dropped, not
//     fatal), partial reads (data split into many tiny chunks), correct
//     timeout behaviour, response without a known request_id (dropped).
//   - SandboxNotAvailableError when no socket exists (Darwin-style fallback).
//
// What we deliberately CAN'T cover here:
//   - Real Cloud Hypervisor.
//   - Real AF_VSOCK semantics (Node has no native AF_VSOCK; CHV bridges to
//     AF_UNIX, which is what we use both in production and in these tests).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  SandboxError,
  SandboxNotAvailableError,
  SandboxToolTimeoutError,
  SandboxVsockFrameTooLargeError,
  SandboxVsockHandshakeError,
} from "../../errors.js";
import { VsockClient, DEFAULT_GUEST_PORT } from "../vsock-client.js";

// --- fake CHV-like AF_UNIX server -----------------------------------------

interface FakeServer {
  server: Server;
  socketPath: string;
  /** Resolves with the connected client socket once handshake bytes start. */
  nextClient: () => Promise<Socket>;
  /** Pops + clears any post-handshake bytes buffered by the server before
   *  the test had a chance to attach its own data listener AND removes
   *  the server's internal onData listener so subsequent bytes flow
   *  straight to the caller's listener. */
  handoff: (sock: Socket) => Buffer;
  close: () => Promise<void>;
}

function startFakeServer(behaviour: {
  handshakeReply?: (port: number) => string | Buffer | null; // null = hang up
  /** If true, write each byte of handshakeReply as its own data event,
   *  exercising the handshake's partial-read path. */
  trickle?: boolean;
}): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const tmpRoot = tmpdir();
    mkdtemp(join(tmpRoot, "vsock-test-"))
      .then((dir) => {
        const socketPath = join(dir, "vsock.sock");
        const incoming: Array<(s: Socket) => void> = [];
        const pending: Socket[] = [];
        const allSockets = new Set<Socket>();
        // Per-socket buffer of post-handshake bytes that arrived before
        // the test attached its own listener. The FrameReader picks these
        // up via `handoff`.
        const leftovers = new WeakMap<Socket, Buffer>();
        const handshakeDone = new WeakSet<Socket>();
        const onDataRefs = new WeakMap<Socket, (c: Buffer) => void>();
        const server = createServer((sock) => {
          allSockets.add(sock);
          sock.on("close", () => allSockets.delete(sock));
          sock.on("error", () => {
            /* swallow -- expected when client destroys its end */
          });
          // CHV-like behaviour: read until newline, then reply.
          let acc = Buffer.alloc(0);
          // While true, we are still consuming bytes for the fake server
          // (handshake + leftover-capture). Once the test code creates a
          // FrameReader it removes this listener via the FrameReader
          // attaching its own; we keep this listener attached for
          // post-handshake bytes that arrive before the test sees the
          // socket so they don't leak into Node's stream void.
          const onData = (chunk: Buffer) => {
            if (handshakeDone.has(sock)) {
              const prev = leftovers.get(sock) ?? Buffer.alloc(0);
              leftovers.set(sock, Buffer.concat([prev, chunk]));
              return;
            }
            acc = Buffer.concat([acc, chunk]);
            const nl = acc.indexOf(0x0a);
            if (nl === -1) return;
            const line = acc.subarray(0, nl).toString("ascii");
            const m = line.match(/^CONNECT\s+(\d+)$/);
            if (m === null) {
              sock.destroy();
              return;
            }
            const port = Number.parseInt(m[1], 10);
            const reply = (
              behaviour.handshakeReply ?? ((p: number) => `OK ${p}\n`)
            )(port);
            handshakeDone.add(sock);
            // Any bytes past the newline are post-handshake frames --
            // stash for the FrameReader.
            const leftover = acc.subarray(nl + 1);
            if (leftover.length > 0) {
              leftovers.set(sock, Buffer.from(leftover));
            }
            if (reply === null) {
              sock.destroy();
              return;
            }
            const buf = Buffer.isBuffer(reply) ? reply : Buffer.from(reply);
            if (behaviour.trickle === true) {
              // Send byte-by-byte to exercise partial-read handling.
              let i = 0;
              const tick = () => {
                if (i >= buf.length) return;
                sock.write(buf.subarray(i, i + 1));
                i++;
                setImmediate(tick);
              };
              tick();
            } else {
              sock.write(buf);
            }
            // Make this socket available to test code (which then drives
            // the post-handshake length-prefixed protocol).
            if (incoming.length > 0) {
              const cb = incoming.shift()!;
              cb(sock);
            } else {
              pending.push(sock);
            }
          };
          sock.on("data", onData);
          onDataRefs.set(sock, onData);
        });
        server.listen(socketPath, () => {
          resolve({
            server,
            socketPath,
            nextClient: () =>
              new Promise<Socket>((r) => {
                if (pending.length > 0) {
                  r(pending.shift()!);
                } else {
                  incoming.push(r);
                }
              }),
            handoff: (sock: Socket) => {
              const v = leftovers.get(sock) ?? Buffer.alloc(0);
              leftovers.delete(sock);
              const ref = onDataRefs.get(sock);
              if (ref !== undefined) {
                sock.removeListener("data", ref);
                onDataRefs.delete(sock);
              }
              return v;
            },
            close: async () => {
              for (const s of allSockets) {
                try {
                  s.destroy();
                } catch {}
              }
              await new Promise<void>((r) => server.close(() => r()));
              await rm(dir, { recursive: true, force: true });
            },
          });
        });
      })
      .catch(reject);
  });
}

/** Helper: write a length-prefixed JSON frame onto a socket. */
function writeFrame(
  sock: Socket,
  obj: unknown,
  opts: { trickle?: boolean } = {},
): void {
  const json = Buffer.from(JSON.stringify(obj), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  if (opts.trickle === true) {
    // Write byte-by-byte to test partial-read handling on the client.
    const all = Buffer.concat([header, json]);
    let i = 0;
    const tick = () => {
      if (i >= all.length) return;
      sock.write(all.subarray(i, i + 1));
      i++;
      setImmediate(tick);
    };
    tick();
  } else {
    sock.write(header);
    sock.write(json);
  }
}

/** Stateful frame reader for the server side -- carries buffered bytes
 *  across `readFrame` calls so back-to-back requests work. The optional
 *  `initialBuf` is for any post-handshake bytes the fake server caught
 *  before this reader was attached. */
class FrameReader {
  private buf: Buffer;
  private expecting: number | null = null;
  private waiter: ((f: Record<string, unknown>) => void) | null = null;
  private failer: ((e: Error) => void) | null = null;

  constructor(
    private readonly sock: Socket,
    initialBuf: Buffer = Buffer.alloc(0),
  ) {
    this.buf = initialBuf;
    sock.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.tryDeliver();
    });
    sock.on("error", (err) => {
      if (this.failer !== null) this.failer(err);
    });
    sock.resume();
  }

  private tryDeliver(): void {
    while (this.waiter !== null) {
      if (this.expecting === null) {
        if (this.buf.length < 4) return;
        this.expecting = this.buf.readUInt32BE(0);
        this.buf = this.buf.subarray(4);
      }
      if (this.buf.length < this.expecting) return;
      const payload = this.buf.subarray(0, this.expecting);
      this.buf = this.buf.subarray(this.expecting);
      this.expecting = null;
      const w = this.waiter;
      this.waiter = null;
      this.failer = null;
      try {
        w(JSON.parse(payload.toString("utf-8")));
      } catch {
        // Malformed -- swallow; next read will see remaining buf.
      }
    }
  }

  read(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.waiter !== null) {
        reject(new Error("FrameReader: concurrent reads not supported"));
        return;
      }
      this.waiter = resolve;
      this.failer = reject;
      this.tryDeliver();
    });
  }
}

/** Convenience: one-shot read. Pass the FakeServer so we can hand off
 *  the socket cleanly (remove the server's internal handshake listener
 *  and recover any post-handshake bytes already buffered). */
function readFrame(
  sock: Socket,
  fake: FakeServer,
): Promise<Record<string, unknown>> {
  return new FrameReader(sock, fake.handoff(sock)).read();
}

// --- tests ------------------------------------------------------------------

describe("VsockClient", () => {
  let fake: FakeServer | null = null;

  afterEach(async () => {
    if (fake !== null) {
      await fake.close();
      fake = null;
    }
  });

  it("throws SandboxNotAvailableError when the socket file is absent", async () => {
    const client = new VsockClient({
      socketPath: "/tmp/this/does/not/exist.sock",
    });
    await expect(client.open()).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
  });

  it("performs a CONNECT/OK handshake and records sourcePort", async () => {
    fake = await startFakeServer({
      handshakeReply: () => "OK 4242\n",
    });
    const client = new VsockClient({
      socketPath: fake.socketPath,
      handshakeTimeoutMs: 2_000,
    });
    await client.open();
    expect(client.isOpen()).toBe(true);
    expect(client.getSourcePort()).toBe(4242);
    await client.close();
  });

  it("tolerates a trickled (partial-read) handshake reply", async () => {
    fake = await startFakeServer({
      handshakeReply: () => "OK 7\n",
      trickle: true,
    });
    const client = new VsockClient({
      socketPath: fake.socketPath,
      handshakeTimeoutMs: 2_000,
    });
    await client.open();
    expect(client.getSourcePort()).toBe(7);
    await client.close();
  });

  it("throws SandboxVsockHandshakeError on a bad handshake reply", async () => {
    fake = await startFakeServer({
      handshakeReply: () => "ERROR no such port\n",
    });
    const client = new VsockClient({ socketPath: fake.socketPath });
    await expect(client.open()).rejects.toBeInstanceOf(
      SandboxVsockHandshakeError,
    );
  });

  it("throws SandboxVsockHandshakeError when peer hangs up mid-handshake", async () => {
    fake = await startFakeServer({
      handshakeReply: () => null, // server destroys the socket
    });
    const client = new VsockClient({ socketPath: fake.socketPath });
    await expect(client.open()).rejects.toBeInstanceOf(
      SandboxVsockHandshakeError,
    );
  });

  it("times out the handshake if the server never replies", async () => {
    fake = await startFakeServer({
      // Reply that never sends a newline; client will time out.
      handshakeReply: () => Buffer.from("OK 1"),
    });
    const client = new VsockClient({
      socketPath: fake.socketPath,
      handshakeTimeoutMs: 100,
    });
    await expect(client.open()).rejects.toBeInstanceOf(
      SandboxVsockHandshakeError,
    );
  });

  it("dispatches a ToolDispatch and demuxes the matching ToolResult", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({
      socketPath: fake.socketPath,
      handshakeTimeoutMs: 2_000,
    });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    // Server-side: read one frame, write back a ToolResult.
    const reqP = readFrame(guestSock, fake!).then((req) => {
      expect(req.type).toBe("ToolDispatch");
      expect(req.command_id).toBe("cmd-1");
      writeFrame(guestSock, {
        type: "ToolResult",
        command_id: req.command_id,
        exit_code: 0,
        stdout: "hello\n",
        stderr: "",
        evidence_hash: "sha256:abc",
      });
    });

    const result = await client.sendCommand({
      command_id: "cmd-1",
      tool: "echo",
      params: { message: "hello" },
      deadline_ms: 2_000,
    });
    await reqP;

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.evidence_hash).toBe("sha256:abc");
    await client.close();
  });

  it("supports multiple in-flight requests correlated by request_id", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({ socketPath: fake.socketPath });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    const reader = new FrameReader(guestSock, fake!.handoff(guestSock));
    const seen: Record<string, unknown>[] = [];
    // Server: collect both requests, then reply in REVERSE order to prove
    // demux-by-request_id is correct.
    const serverWork = (async () => {
      const a = await reader.read();
      const b = await reader.read();
      seen.push(a, b);
      writeFrame(guestSock, {
        type: "ToolResult",
        command_id: b.command_id,
        exit_code: 2,
        stdout: "B-reply",
        stderr: "",
      });
      writeFrame(guestSock, {
        type: "ToolResult",
        command_id: a.command_id,
        exit_code: 1,
        stdout: "A-reply",
        stderr: "",
      });
    })();

    const [r1, r2] = await Promise.all([
      client.sendCommand({
        command_id: "cmd-1",
        tool: "echo",
        params: {},
        deadline_ms: 3_000,
      }),
      client.sendCommand({
        command_id: "cmd-2",
        tool: "echo",
        params: {},
        deadline_ms: 3_000,
      }),
    ]);
    await serverWork;

    // The order responses arrive at the client follows the server's
    // write order (reply to B first, then A). But sendCommand resolves
    // by request_id, so r1 is whatever the response with command_id "cmd-1"
    // says, regardless of arrival order.
    expect(seen.map((f) => f.command_id).sort()).toEqual(["cmd-1", "cmd-2"]);
    // r1's exit_code corresponds to whichever of seen[0]/seen[1] has command_id cmd-1.
    const cmd1Pos = seen.findIndex((f) => f.command_id === "cmd-1");
    const cmd2Pos = seen.findIndex((f) => f.command_id === "cmd-2");
    // Server replies B (seen[1]) with exit 2, A (seen[0]) with exit 1.
    expect(r1.exit_code).toBe(cmd1Pos === 0 ? 1 : 2);
    expect(r2.exit_code).toBe(cmd2Pos === 0 ? 1 : 2);
    await client.close();
  });

  it("handles partial reads (response written byte-by-byte)", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({ socketPath: fake.socketPath });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    const serverWork = readFrame(guestSock, fake!).then((req) => {
      writeFrame(
        guestSock,
        {
          type: "ToolResult",
          command_id: req.command_id,
          exit_code: 0,
          stdout: "trickled",
          stderr: "",
        },
        { trickle: true },
      );
    });

    const result = await client.sendCommand({
      command_id: "cmd-trickle",
      tool: "echo",
      params: {},
      deadline_ms: 2_000,
    });
    await serverWork;
    expect(result.stdout).toBe("trickled");
    await client.close();
  });

  it("times out a request whose response never arrives", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({ socketPath: fake.socketPath });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    // Read the request but never reply.
    const eat = readFrame(guestSock, fake!).catch(() => {});

    await expect(
      client.sendCommand({
        command_id: "cmd-timeout",
        tool: "echo",
        params: {},
        deadline_ms: 50,
      }),
    ).rejects.toBeInstanceOf(SandboxToolTimeoutError);
    await eat;
    await client.close();
  });

  it("rejects an oversized inbound frame as SandboxVsockFrameTooLargeError", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({
      socketPath: fake.socketPath,
      // Small enough to exceed easily but big enough to hold the 4-byte
      // outbound request frame (json is ~80 bytes for our minimal payload).
      maxFrameBytes: 1024,
    });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    // Server: read the request, then write ONLY a length-prefix header
    // declaring an enormous payload. The client must latch a fatal
    // SandboxVsockFrameTooLargeError without blocking on payload bytes.
    const reader = new FrameReader(guestSock, fake!.handoff(guestSock));
    const eat = reader.read().then(() => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(99_999_999, 0);
      guestSock.write(header);
    });

    const sendP = client.sendCommand({
      command_id: "cmd-big",
      tool: "echo",
      params: {},
      deadline_ms: 3_000,
    });

    await expect(sendP).rejects.toBeInstanceOf(SandboxVsockFrameTooLargeError);
    await eat;
    expect(client.isOpen()).toBe(false);
    await client.close();
  });

  it("rejects an oversized OUTBOUND frame before sending", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({
      socketPath: fake.socketPath,
      maxFrameBytes: 32,
    });
    const openP = client.open();
    void (await fake.nextClient());
    await openP;

    const huge = "x".repeat(1024);
    await expect(
      client.sendCommand({
        command_id: "cmd-outbound-big",
        tool: huge,
        params: { huge },
        deadline_ms: 2_000,
      }),
    ).rejects.toBeInstanceOf(SandboxVsockFrameTooLargeError);
    await client.close();
  });

  it("drops a malformed JSON frame without poisoning the connection", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({ socketPath: fake.socketPath });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    // Send a malformed JSON frame, then read req-1 and reply normally.
    const garbage = Buffer.from("{not json");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(garbage.length, 0);
    guestSock.write(header);
    guestSock.write(garbage);

    const serverWork = readFrame(guestSock, fake!).then((req) => {
      writeFrame(guestSock, {
        type: "ToolResult",
        command_id: req.command_id,
        exit_code: 0,
        stdout: "still alive",
        stderr: "",
      });
    });

    const r = await client.sendCommand({
      command_id: "cmd-after-garbage",
      tool: "echo",
      params: {},
      deadline_ms: 2_000,
    });
    await serverWork;
    expect(r.stdout).toBe("still alive");
    expect(client.isOpen()).toBe(true);
    await client.close();
  });

  it("drops a frame whose request_id matches no pending call", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({ socketPath: fake.socketPath });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    // Push a stray result for a request the client never made.
    writeFrame(guestSock, {
      type: "ToolResult",
      command_id: "cmd-stray",
      exit_code: 0,
      stdout: "",
      stderr: "",
    });

    // Wait a tick so the read loop processes it.
    await new Promise((r) => setTimeout(r, 25));
    expect(client.isOpen()).toBe(true);

    // Subsequent real request still works.
    const serverWork = readFrame(guestSock, fake!).then((req) => {
      writeFrame(guestSock, {
        type: "ToolResult",
        command_id: req.command_id,
        exit_code: 0,
        stdout: "ok",
        stderr: "",
      });
    });
    const r = await client.sendCommand({
      command_id: "cmd-real",
      tool: "echo",
      params: {},
      deadline_ms: 2_000,
    });
    await serverWork;
    expect(r.stdout).toBe("ok");
    await client.close();
  });

  it("performs a GuestQuery / GuestResponse round trip", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({ socketPath: fake.socketPath });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    const serverWork = readFrame(guestSock, fake!).then((req) => {
      expect(req.type).toBe("GuestQuery");
      expect(req.query_kind).toBe("OpenFdCount");
      writeFrame(guestSock, {
        type: "GuestResponse",
        query_id: req.query_id,
        query_kind: "OpenFdCount",
        result: { open_fd_count: 12 },
        ts: new Date().toISOString(),
      });
    });

    const result = await client.guestQuery("OpenFdCount", {
      timeoutMs: 1_000,
      queryId: "q-1",
    });
    await serverWork;
    expect((result as { open_fd_count: number }).open_fd_count).toBe(12);
    await client.close();
  });

  it("uses the default guest port (1024) in the CONNECT line", async () => {
    let observedPort = -1;
    fake = await startFakeServer({
      handshakeReply: (port) => {
        observedPort = port;
        return `OK ${port}\n`;
      },
    });
    const client = new VsockClient({ socketPath: fake.socketPath });
    await client.open();
    expect(observedPort).toBe(DEFAULT_GUEST_PORT);
    await client.close();
  });

  it("trips SANDBOX_VSOCK_PARTIAL_FRAME_TIMEOUT when a frame stalls mid-payload (protocol §6)", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({
      socketPath: fake.socketPath,
      partialFrameTimeoutMs: 100, // shrunk from default 30_000 for fast test
    });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    // Server reads the request, then writes a 4-byte length header
    // declaring a 1024-byte payload — and stops. The client should
    // arm the partial-frame watchdog and fire after 100ms.
    const serverWork = readFrame(guestSock, fake!).then(() => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(1024, 0);
      guestSock.write(header);
      // Intentionally do NOT write the payload.
    });

    const sendP = client.sendCommand({
      command_id: "cmd-stall",
      tool: "echo",
      params: {},
      deadline_ms: 5_000, // way longer than the watchdog timeout
    });

    const err = await sendP.catch((e: unknown) => e);
    await serverWork;
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe(
      "SANDBOX_VSOCK_PARTIAL_FRAME_TIMEOUT",
    );
    expect(client.isOpen()).toBe(false);
    await client.close();
  });

  it("does not trip partial-frame timeout for a slow-but-progressing peer", async () => {
    fake = await startFakeServer({});
    const client = new VsockClient({
      socketPath: fake.socketPath,
      partialFrameTimeoutMs: 200,
    });
    const openP = client.open();
    const guestSock = await fake.nextClient();
    await openP;

    // Server trickles the response one byte at a time at ~50ms intervals
    // — slower than our normal "trickle: true" but still strictly faster
    // than the 200ms watchdog. Each new byte resets the watchdog.
    const serverWork = readFrame(guestSock, fake!).then(async (req) => {
      const payload = Buffer.from(
        JSON.stringify({
          type: "ToolResult",
          command_id: req.command_id,
          exit_code: 0,
          stdout: "slow",
          stderr: "",
        }),
        "utf-8",
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      const all = Buffer.concat([header, payload]);
      for (let i = 0; i < all.length; i++) {
        guestSock.write(all.subarray(i, i + 1));
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    const result = await client.sendCommand({
      command_id: "cmd-slow",
      tool: "echo",
      params: {},
      deadline_ms: 30_000,
    });
    await serverWork;
    expect(result.stdout).toBe("slow");
    expect(client.isOpen()).toBe(true);
    await client.close();
  }, 30_000);
});
