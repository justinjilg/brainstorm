/**
 * RoutingEventStream — subscriber for BR's push-first routing-decision SSE.
 *
 * BR's `GET /v1/routing-stream` emits one `routing-decision` event per routing
 * decision it makes on behalf of our tenant. This class:
 *
 *   1. Opens an authenticated SSE connection.
 *   2. Parses the SSE frames (event/id/data) per the phase-1 contract at
 *      `~/Projects/brainstormrouter/docs/push-first-coordination-phase-1.md`.
 *   3. Tracks the last event id so reconnects can replay via `Last-Event-ID`.
 *   4. Reconnects with exponential backoff (1s, 2s, 4s, 8s cap) when the
 *      connection drops or returns a non-2xx.
 *   5. Detects event-id gaps (BR's per-tenant ring buffer is bounded, so a
 *      long disconnect can lose events) and logs a warning.
 *   6. Exposes a simple subscribe() API for the TUI panel + any strategy
 *      observers. Keepalive comments from the server (`: keepalive`) are
 *      filtered; they arrive silently every 15s and are not surfaced to
 *      subscribers.
 */

import { createLogger } from "@brainst0rm/shared";

const log = createLogger("routing-stream");

export interface RoutingDecision {
  ts: string;
  request_id: string;
  task_type: string;
  selected_model: string;
  strategy: string;
  why: string;
  cost_estimate_usd: number;
  cache: "hit" | "miss" | "skip";
  tenant_id: string;
}

export interface RoutingStreamEvent {
  eventId: number;
  decision: RoutingDecision;
}

export type ConnectionState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "open" }
  | { phase: "reconnecting"; attempt: number; nextAttemptMs: number }
  | { phase: "closed"; reason?: string };

export interface RoutingStreamOptions {
  baseUrl: string;
  apiKey: string;
  /** Override the starting last-event-id (useful for tests). */
  initialLastEventId?: number;
  /** Max reconnect backoff in milliseconds. Default 8000 (8s cap). */
  maxBackoffMs?: number;
  /** AbortSignal for clean shutdown. */
  signal?: AbortSignal;
}

type EventCallback = (event: RoutingStreamEvent) => void;
type GapCallback = (gapSize: number) => void;
type StateCallback = (state: ConnectionState) => void;

export class RoutingEventStream {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxBackoffMs: number;
  private readonly controller: AbortController;
  private readonly externalSignal?: AbortSignal;

  private lastEventId: number;
  private attempt = 0;
  private state: ConnectionState = { phase: "idle" };
  private readonly eventSubs = new Set<EventCallback>();
  private readonly gapSubs = new Set<GapCallback>();
  private readonly stateSubs = new Set<StateCallback>();

  constructor(opts: RoutingStreamOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.maxBackoffMs = opts.maxBackoffMs ?? 8000;
    this.lastEventId = opts.initialLastEventId ?? 0;
    this.controller = new AbortController();
    this.externalSignal = opts.signal;
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => this.controller.abort());
    }
  }

  /** Subscribe to routing-decision events. Returns an unsubscribe function. */
  onEvent(cb: EventCallback): () => void {
    this.eventSubs.add(cb);
    return () => this.eventSubs.delete(cb);
  }

  /**
   * Subscribe to gap notifications. `gapSize` is the number of events skipped
   * between the last-seen id and the first id after reconnect. Non-zero means
   * BR's ring buffer evicted events while the client was disconnected.
   */
  onGap(cb: GapCallback): () => void {
    this.gapSubs.add(cb);
    return () => this.gapSubs.delete(cb);
  }

  /** Subscribe to connection-state transitions. */
  onState(cb: StateCallback): () => void {
    this.stateSubs.add(cb);
    cb(this.state);
    return () => this.stateSubs.delete(cb);
  }

  getLastEventId(): number {
    return this.lastEventId;
  }

  getState(): ConnectionState {
    return this.state;
  }

  /** Start the connect/reconnect loop. Returns immediately; runs in background. */
  start(): void {
    if (this.state.phase !== "idle") return;
    void this.loop();
  }

  /** Cleanly tear down the stream. */
  stop(reason?: string): void {
    this.setState({ phase: "closed", reason });
    this.controller.abort();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private setState(next: ConnectionState) {
    this.state = next;
    for (const cb of this.stateSubs) cb(next);
  }

  private async loop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      this.setState({ phase: "connecting" });
      try {
        await this.connectOnce();
      } catch (err) {
        if (this.controller.signal.aborted) return;
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "routing-stream connection error",
        );
      }
      if (this.controller.signal.aborted) return;
      this.attempt++;
      const delay = Math.min(1000 * 2 ** (this.attempt - 1), this.maxBackoffMs);
      this.setState({
        phase: "reconnecting",
        attempt: this.attempt,
        nextAttemptMs: delay,
      });
      await sleep(delay, this.controller.signal);
    }
  }

  private async connectOnce(): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "text/event-stream",
    };
    if (this.lastEventId > 0) {
      headers["Last-Event-ID"] = String(this.lastEventId);
    }

    const res = await fetch(`${this.baseUrl}/v1/routing-stream`, {
      method: "GET",
      headers,
      signal: this.controller.signal,
    });

    if (!res.ok) {
      throw new Error(
        `routing-stream HTTP ${res.status}: ${await safeText(res)}`,
      );
    }
    if (!res.body) {
      throw new Error("routing-stream response has no body");
    }

    this.attempt = 0;
    this.setState({ phase: "open" });

    await this.parseStream(res.body);
  }

  private async parseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are delimited by blank lines (\n\n or \r\n\r\n).
        // We split greedily and keep any trailing partial frame in the buffer.
        let sepIdx: number;
        while ((sepIdx = indexOfFrameSep(buffer)) !== -1) {
          const frame = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + frameSepLen(buffer, sepIdx));
          this.handleFrame(frame);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleFrame(raw: string): void {
    if (!raw.trim()) return;

    let eventName = "message";
    let idStr: string | null = null;
    const dataLines: string[] = [];

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine;
      if (!line) continue;
      if (line.startsWith(":")) continue; // SSE comment (e.g. keepalive)
      const colonIdx = line.indexOf(":");
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      const value =
        colonIdx === -1 ? "" : line.slice(colonIdx + 1).replace(/^ /, "");
      switch (field) {
        case "event":
          eventName = value;
          break;
        case "id":
          idStr = value;
          break;
        case "data":
          dataLines.push(value);
          break;
        default:
          // Unknown field — SSE spec says ignore.
          break;
      }
    }

    if (eventName !== "routing-decision") return;
    if (dataLines.length === 0) return;

    const eventId = idStr !== null ? parseInt(idStr, 10) : NaN;
    if (!Number.isFinite(eventId)) {
      log.warn({ eventName }, "routing-stream event missing numeric id");
      return;
    }

    let decision: RoutingDecision;
    try {
      decision = JSON.parse(dataLines.join("\n")) as RoutingDecision;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "routing-stream event failed to parse",
      );
      return;
    }

    // Gap detection: if the new id skips forward by more than 1 past the
    // previous, the server-side ring buffer dropped events for us.
    const prev = this.lastEventId;
    if (prev > 0 && eventId > prev + 1) {
      const gap = eventId - prev - 1;
      log.warn({ prev, eventId, gap }, "routing-stream event-id gap");
      for (const cb of this.gapSubs) cb(gap);
    }
    this.lastEventId = eventId;

    const outbound: RoutingStreamEvent = { eventId, decision };
    for (const cb of this.eventSubs) {
      try {
        cb(outbound);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "routing-stream subscriber threw",
        );
      }
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Returns the index of the SSE frame separator (\n\n or \r\n\r\n) or -1. */
function indexOfFrameSep(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function frameSepLen(buf: string, idx: number): number {
  return buf.startsWith("\r\n\r\n", idx) ? 4 : 2;
}
