/**
 * Programmatic HTTP client for the broker daemon.
 *
 * One instance per storm CLI process. Owns the peer ID assigned at register
 * time, drives heartbeat + message-poll timers, and surfaces peer ops as
 * promise-returning methods.
 *
 * Failure modes are modeled explicitly — network errors propagate as thrown
 * errors for register/send/list, and heartbeat/poll loops swallow transient
 * failures with a debug log (so a flapping broker doesn't crash the CLI).
 */

import { createHash } from "node:crypto";
import { createLogger } from "@brainst0rm/shared";
import type {
  HealthResponse,
  Message,
  Peer,
  PeerId,
  PeerScope,
  RegisterResponse,
  SendMessageResponse,
} from "./types.js";
import { DEFAULT_BROKER_PORT } from "./daemon.js";

const log = createLogger("broker-client");

export interface BrokerClientOptions {
  /** Port to talk to. Default 7900. */
  port?: number;
  /** API key (raw) — hashed to a fingerprint for the broker. Never sent raw. */
  apiKey: string;
  /** Registration metadata. */
  pid: number;
  cwd: string;
  git_root?: string | null;
  tty?: string | null;
  summary?: string;
  /** Heartbeat cadence. Default 15s. */
  heartbeatIntervalMs?: number;
  /** Poll cadence for inbound messages. Default 1s. */
  pollIntervalMs?: number;
  /** HTTP timeout for a single request. Default 3s. */
  requestTimeoutMs?: number;
}

export type MessageCallback = (msg: Message) => void | Promise<void>;

/**
 * Derive the opaque auth fingerprint from a raw API key. 16 hex chars ≈ 64
 * bits — enough collision resistance for tenant boundary checks, small
 * enough to log without leaking secret shape.
 */
export function fingerprintApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export class BrokerClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fingerprint: string;
  private readonly meta: {
    pid: number;
    cwd: string;
    git_root: string | null;
    tty: string | null;
    summary: string;
  };
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;

  private peerId: PeerId | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly messageSubs = new Set<MessageCallback>();
  private stopped = false;

  constructor(opts: BrokerClientOptions) {
    this.baseUrl = `http://127.0.0.1:${opts.port ?? DEFAULT_BROKER_PORT}`;
    this.apiKey = opts.apiKey;
    this.fingerprint = fingerprintApiKey(opts.apiKey);
    this.meta = {
      pid: opts.pid,
      cwd: opts.cwd,
      git_root: opts.git_root ?? null,
      tty: opts.tty ?? null,
      summary: opts.summary ?? "",
    };
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 3_000;
  }

  getFingerprint(): string {
    return this.fingerprint;
  }

  getPeerId(): PeerId | null {
    return this.peerId;
  }

  /**
   * Register with the broker and start heartbeat + poll loops. Idempotent —
   * re-registering an already-registered PID replaces the prior row on the
   * broker side, so a crash-restart doesn't leave a stale entry.
   */
  async start(): Promise<PeerId> {
    const res = (await this.post("/register", {
      pid: this.meta.pid,
      cwd: this.meta.cwd,
      git_root: this.meta.git_root,
      tty: this.meta.tty,
      summary: this.meta.summary,
      auth_fingerprint: this.fingerprint,
    })) as RegisterResponse;
    this.peerId = res.id;

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick();
    }, this.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }

    this.pollTimer = setInterval(() => {
      void this.pollTick();
    }, this.pollIntervalMs);
    if (typeof this.pollTimer.unref === "function") {
      this.pollTimer.unref();
    }

    return res.id;
  }

  /**
   * Tear down timers and send an /unregister so the broker doesn't wait for
   * the stale-reap to drop us. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.peerId) {
      try {
        await this.post("/unregister", { id: this.peerId });
      } catch (err) {
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          "unregister failed (broker may already be down)",
        );
      }
      this.peerId = null;
    }
  }

  /** Register a message callback. Returns an unsubscribe function. */
  onMessage(cb: MessageCallback): () => void {
    this.messageSubs.add(cb);
    return () => this.messageSubs.delete(cb);
  }

  async listPeers(scope: PeerScope = "machine"): Promise<Peer[]> {
    this.requirePeerId();
    return (await this.post("/list-peers", {
      scope,
      caller_id: this.peerId,
      auth_fingerprint: this.fingerprint,
      cwd: this.meta.cwd,
      git_root: this.meta.git_root,
    })) as Peer[];
  }

  async sendMessage(toId: PeerId, text: string): Promise<void> {
    this.requirePeerId();
    const res = (await this.post("/send-message", {
      from_id: this.peerId,
      to_id: toId,
      text,
      auth_fingerprint: this.fingerprint,
    })) as SendMessageResponse;
    if (!res.ok) {
      throw new Error(res.error ?? "send-message failed");
    }
  }

  async setSummary(summary: string): Promise<void> {
    this.requirePeerId();
    this.meta.summary = summary;
    await this.post("/set-summary", { id: this.peerId, summary });
  }

  async health(): Promise<HealthResponse> {
    return (await this.get("/health")) as HealthResponse;
  }

  // ── internals ────────────────────────────────────────────────────────

  private requirePeerId(): void {
    if (!this.peerId) {
      throw new Error("BrokerClient not started — call start() first");
    }
  }

  private async heartbeatTick(): Promise<void> {
    if (!this.peerId) return;
    try {
      await this.post("/heartbeat", { id: this.peerId });
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "heartbeat failed",
      );
    }
  }

  private async pollTick(): Promise<void> {
    if (!this.peerId || this.messageSubs.size === 0) return;
    try {
      const res = (await this.post("/poll-messages", {
        id: this.peerId,
      })) as { messages: Message[] };
      for (const msg of res.messages) {
        for (const cb of this.messageSubs) {
          try {
            await cb(msg);
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              "message subscriber threw",
            );
          }
        }
      }
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "poll failed",
      );
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `broker ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return res.json();
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `broker ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return res.json();
  }
}
