import type { SlackClient } from "./client.js";

/**
 * Minimal shape of the WebSocket surface SlackSocket depends on, so tests
 * can supply a scripted fake without pulling in a real WebSocket impl.
 */
export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  // Handler params are typed `any` (rather than the stricter `unknown`/
  // `{ data: unknown }`) so that a real `WebSocket` — whose handlers are
  // contravariant in `this: WebSocket, ev: Event`/`MessageEvent` — remains
  // structurally assignable to this interface. A `(url: string) => WebSocket`
  // factory (the contract type used by SlackAdapter) satisfies `WsFactory`.
  onopen: ((ev?: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev?: any) => void) | null;
  onerror: ((ev?: any) => void) | null;
}

export type WsFactory = (url: string) => MinimalWebSocket;

interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: unknown;
  reason?: string;
  [key: string]: unknown;
}

export interface SlackSocketOptions {
  appToken: string;
  client: SlackClient;
  onEvent: (payload: unknown, envelopeId: string) => void;
  wsFactory?: WsFactory;
  /** Overridable for tests; defaults to real setTimeout. */
  scheduleReconnect?: (fn: () => void, delayMs: number) => void;
  onLog?: (msg: string, err?: unknown) => void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export class SlackSocket {
  private readonly appToken: string;
  private readonly client: SlackClient;
  private readonly onEvent: (payload: unknown, envelopeId: string) => void;
  private readonly wsFactory: WsFactory;
  private readonly scheduleReconnect: (fn: () => void, delayMs: number) => void;
  private readonly onLog: (msg: string, err?: unknown) => void;

  private ws: MinimalWebSocket | null = null;
  private stopped = false;
  private backoffMs = MIN_BACKOFF_MS;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SlackSocketOptions) {
    this.appToken = opts.appToken;
    this.client = opts.client;
    this.onEvent = opts.onEvent;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.scheduleReconnect =
      opts.scheduleReconnect ??
      ((fn, delayMs) => {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          fn();
        }, delayMs);
      });
    this.onLog = opts.onLog ?? (() => {});
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    // Guard against overlapping connections (e.g. start() called twice, or a
    // reconnect racing an in-flight one): close any live socket first so it
    // can't be orphaned once `this.ws` is overwritten below.
    if (this.ws) {
      const stale = this.ws;
      this.ws = null;
      try {
        stale.close();
      } catch {
        // ignore
      }
    }

    let url: string;
    try {
      ({ url } = await this.client.connectionsOpen(this.appToken));
    } catch (err) {
      this.onLog("connectionsOpen failed", err);
      this.scheduleRetry();
      return;
    }

    if (this.stopped) return;

    const socket = this.wsFactory(url);
    this.ws = socket;

    socket.onopen = () => {
      // Backoff resets on a *proven-good* connection (receipt of the
      // "hello" envelope in handleMessage), not merely on the WebSocket
      // handshake completing — a server that accepts the handshake and
      // then immediately closes (auth revoked, LB flapping) should not
      // reset us back into a tight 1s reconnect loop.
    };

    socket.onmessage = (ev) => {
      this.handleMessage(ev.data, socket);
    };

    socket.onclose = () => {
      // If `this.ws` is no longer `socket`, the close was intentional
      // (stop() or reconnectNow() already cleared it and is/would be
      // driving reconnection itself) — don't schedule a duplicate retry.
      if (this.ws !== socket) {
        return;
      }
      this.ws = null;
      if (!this.stopped) {
        this.scheduleRetry();
      }
    };

    socket.onerror = (err) => {
      this.onLog("socket error", err);
    };
  }

  private handleMessage(data: unknown, socket: MinimalWebSocket): void {
    let envelope: SlackEnvelope;
    try {
      const raw = typeof data === "string" ? data : String(data);
      envelope = JSON.parse(raw) as SlackEnvelope;
    } catch (err) {
      this.onLog("malformed frame", err);
      return;
    }

    if (!envelope || typeof envelope !== "object") {
      this.onLog("malformed frame: not an object");
      return;
    }

    const { type, envelope_id: envelopeId } = envelope;

    if (envelopeId) {
      // Ack on the socket the envelope actually arrived on — not
      // `this.ws` — so a message delivered by a superseded-but-not-yet-
      // torn-down socket is acked on the connection Slack expects.
      this.ack(envelopeId, socket);
    }

    if (type === "hello") {
      // A "hello" is Slack's confirmation the new connection is live and
      // healthy; only now do we consider the reconnect a success.
      this.backoffMs = MIN_BACKOFF_MS;
      return;
    }

    if (type === "disconnect") {
      this.reconnectNow();
      return;
    }

    if (type === "events_api") {
      this.onEvent(envelope.payload, envelopeId ?? "");
      return;
    }

    // Unknown envelope type: already acked (if it had an id); nothing else to do.
  }

  private ack(envelopeId: string, socket: MinimalWebSocket): void {
    try {
      socket.send(JSON.stringify({ envelope_id: envelopeId }));
    } catch (err) {
      this.onLog("ack send failed", err);
    }
  }

  private reconnectNow(): void {
    const socket = this.ws;
    // Clear before close() so the onclose handler (which may fire
    // synchronously) recognizes this as an intentional close and does not
    // also schedule a retry.
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    if (!this.stopped) {
      void this.connect();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.scheduleReconnect(() => {
      void this.connect();
    }, delay);
  }
}

function defaultWsFactory(url: string): MinimalWebSocket {
  const ws = new WebSocket(url) as unknown as MinimalWebSocket & {
    addEventListener?: never;
  };
  return ws;
}
