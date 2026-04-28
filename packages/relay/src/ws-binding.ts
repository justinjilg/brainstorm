// WS-binding — actual WebSocket server using the `ws` library, wrapping
// each connection as a TransportHandle and routing parsed frames to the
// RelayServer.
//
// Path routing:
//   /v1/operator          → operator handshake + frame dispatch
//   /v1/endpoint/connect  → endpoint handshake + frame dispatch
//
// Each WS connection lives until close; on close, registered sessions are
// removed from SessionStore. Frames are JSON text frames per protocol §2.

import { WebSocketServer, type WebSocket as WS } from "ws";
import type { IncomingMessage } from "node:http";

import type { TransportHandle, SessionStore } from "./session-store.js";
import type { RelayServer } from "./relay-server.js";
import type {
  CommandAck,
  CommandResult,
  ConfirmRequest,
  DispatchRequest,
  EndpointHello,
  ErrorEventEndpointToRelay,
  ProgressEventEndpointSide,
} from "./types.js";

// ---------------------------------------------------------------------------

export interface WsBindingOptions {
  /** Port to listen on. */
  port: number;
  /** Host to bind. Defaults to "127.0.0.1" for laptop-loopback dev. */
  host?: string;
  server: RelayServer;
  sessions: SessionStore;
  /** Optional: emitted on incoming connections for observability. */
  onConnection?: (path: string, remoteAddr: string) => void;
}

export interface WsBindingHandle {
  /** Stop the server gracefully. Returns when all connections are closed. */
  close(): Promise<void>;
  /** The actual port the server is listening on (useful when port=0). */
  port(): number;
}

/**
 * Start a WebSocket server bound to the given port and route incoming
 * connections to the RelayServer.
 */
export function startWsBinding(
  opts: WsBindingOptions,
): Promise<WsBindingHandle> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      port: opts.port,
      host: opts.host ?? "127.0.0.1",
      perMessageDeflate: false, // text frames are small JSON; no compression
    });

    const activeSockets = new Set<WS>();

    wss.on("error", (err) => {
      reject(err);
    });

    wss.on("listening", () => {
      const addr = wss.address();
      const actualPort =
        typeof addr === "object" && addr !== null && "port" in addr
          ? (addr as { port: number }).port
          : opts.port;

      wss.on("connection", (ws: WS, req: IncomingMessage) => {
        activeSockets.add(ws);
        ws.on("close", () => activeSockets.delete(ws));

        const url = req.url ?? "";
        opts.onConnection?.(url, req.socket.remoteAddress ?? "?");

        // Strip query string for routing
        const path = url.split("?")[0];

        if (path === "/v1/operator") {
          handleOperatorConnection({ ws, server: opts.server });
        } else if (path === "/v1/endpoint/connect") {
          handleEndpointConnection({
            ws,
            server: opts.server,
            sessions: opts.sessions,
          });
        } else {
          ws.close(1008, `unknown path: ${path}`);
        }
      });

      resolve({
        async close() {
          for (const ws of activeSockets) {
            try {
              ws.close(1001, "server shutdown");
            } catch {}
          }
          await new Promise<void>((res, rej) => {
            wss.close((err) => (err ? rej(err) : res()));
          });
        },
        port() {
          return actualPort;
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------

function makeTransport(ws: WS): TransportHandle {
  let alive = true;
  ws.on("close", () => {
    alive = false;
  });
  ws.on("error", () => {
    alive = false;
  });
  return {
    async send(frame: unknown): Promise<void> {
      if (!alive) throw new Error("transport closed");
      const text = JSON.stringify(frame);
      await new Promise<void>((resolve, reject) => {
        ws.send(text, (err) => (err ? reject(err) : resolve()));
      });
    },
    async close(reason?: string): Promise<void> {
      if (!alive) return;
      alive = false;
      ws.close(1000, reason ?? "");
    },
    isAlive(): boolean {
      return alive && ws.readyState === ws.OPEN;
    },
  };
}

// ---------------------------------------------------------------------------

interface OperatorConnectionContext {
  ws: WS;
  server: RelayServer;
}

function handleOperatorConnection(ctx: OperatorConnectionContext): void {
  const transport = makeTransport(ctx.ws);
  let operator_session_id: string | null = null;

  ctx.ws.on("message", async (data) => {
    let bytes: Uint8Array;
    if (data instanceof Buffer) bytes = new Uint8Array(data);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (Array.isArray(data)) {
      // Fragmented; concatenate
      const total = data.reduce((s, b) => s + b.byteLength, 0);
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const b of data) {
        bytes.set(new Uint8Array(b), offset);
        offset += b.byteLength;
      }
    } else {
      ctx.ws.close(1003, "non-binary/buffer message");
      return;
    }

    if (operator_session_id === null) {
      // First frame must be OperatorHello
      // CAF mTLS note: RelayServer.cafVerifier is the verification seam, but
      // the real WS binding does not yet extract TLS peer certificates in
      // v0.1.0. Full presentedCert plumbing requires Caddy mTLS termination
      // plus `req.socket.getPeerCertificate(true)` on the upgrade request.
      // When cafVerifier is configured and no cert is presented here, the
      // relay returns AUTH_MODE_NOT_SUPPORTED, preserving pre-flag rejection
      // behavior instead of accepting unauthenticated CAF claims.
      const accept = await ctx.server.acceptOperatorHello({
        transport,
        helloBytes: bytes,
      });
      if (!accept.ok) {
        try {
          await transport.send(accept.error);
        } catch {}
        ctx.ws.close(1008, accept.error.code);
        return;
      }
      operator_session_id = accept.operator_session_id;
      try {
        await transport.send(accept.ack);
      } catch {}
      return;
    }

    // Subsequent frames: parse type, dispatch
    let frame: { type: string };
    try {
      frame = JSON.parse(new TextDecoder().decode(bytes)) as { type: string };
    } catch {
      ctx.ws.close(1003, "invalid JSON");
      return;
    }

    if (frame.type === "DispatchRequest") {
      const result = await ctx.server.handleDispatchRequest({
        operator_session_id,
        request: frame as unknown as DispatchRequest,
        request_bytes: bytes,
      });
      if (result.ok) {
        await transport.send(result.preview);
      } else {
        await transport.send(result.error);
      }
    } else if (frame.type === "ConfirmRequest") {
      const result = await ctx.server.handleConfirmRequest({
        operator_session_id,
        confirm: frame as unknown as ConfirmRequest,
      });
      if (result.ok) {
        // Send the envelope to endpoint, then start ACK timer
        await result.endpoint_transport.send(result.envelope);
        ctx.server.startAckTimer(result.command_id);
      } else {
        await transport.send(result.error);
      }
    } else {
      // Unknown / unsupported frame type from operator
      try {
        await transport.send({
          type: "ErrorEvent",
          request_id:
            (frame as { request_id?: string }).request_id ?? "(unknown)",
          command_id: null,
          code: "AUTH_MALFORMED",
          message: `unsupported operator frame type: ${frame.type}`,
          ts: new Date().toISOString(),
        });
      } catch {}
    }
  });
}

// ---------------------------------------------------------------------------

interface EndpointConnectionContext {
  ws: WS;
  server: RelayServer;
  sessions: SessionStore;
}

function handleEndpointConnection(ctx: EndpointConnectionContext): void {
  const transport = makeTransport(ctx.ws);
  let endpoint_session_id: string | null = null;

  ctx.ws.on("message", async (data) => {
    let bytes: Uint8Array;
    if (data instanceof Buffer) bytes = new Uint8Array(data);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (Array.isArray(data)) {
      const total = data.reduce((s, b) => s + b.byteLength, 0);
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const b of data) {
        bytes.set(new Uint8Array(b), offset);
        offset += b.byteLength;
      }
    } else {
      ctx.ws.close(1003, "non-binary/buffer message");
      return;
    }

    if (endpoint_session_id === null) {
      let hello: EndpointHello;
      try {
        hello = JSON.parse(new TextDecoder().decode(bytes)) as EndpointHello;
        if (hello.type !== "EndpointHello")
          throw new Error("not EndpointHello");
      } catch {
        ctx.ws.close(1003, "first frame must be EndpointHello");
        return;
      }
      const accept = await ctx.server.acceptEndpointHello({
        transport,
        hello,
      });
      if (!accept.ok) {
        ctx.ws.close(1008, accept.code);
        return;
      }
      endpoint_session_id = accept.session_id;
      try {
        await transport.send(accept.ack);
      } catch {}
      return;
    }

    let frame: { type: string };
    try {
      frame = JSON.parse(new TextDecoder().decode(bytes)) as { type: string };
    } catch {
      ctx.ws.close(1003, "invalid JSON");
      return;
    }

    switch (frame.type) {
      case "CommandAck":
        await ctx.server.handleEndpointCommandAck(
          frame as unknown as CommandAck,
        );
        break;
      case "ProgressEvent":
        await ctx.server.handleEndpointProgressEvent(
          frame as unknown as ProgressEventEndpointSide,
        );
        break;
      case "CommandResult":
        await ctx.server.handleEndpointCommandResult(
          frame as unknown as CommandResult,
        );
        break;
      case "ErrorEvent":
        await ctx.server.handleEndpointErrorEvent(
          frame as unknown as ErrorEventEndpointToRelay,
        );
        break;
      case "HealthPing":
        // Reply with HealthPong (best-effort; spec §5.4)
        try {
          await transport.send({
            type: "HealthPong",
            session_id: endpoint_session_id,
            ts: new Date().toISOString(),
            ping_id: (frame as { ping_id?: string }).ping_id ?? "(missing)",
            agent_health: "ok",
          });
        } catch {}
        break;
      default:
        // Unknown frame type from endpoint — log and ignore
        break;
    }
  });

  ctx.ws.on("close", () => {
    if (endpoint_session_id !== null) {
      ctx.sessions.removeEndpoint(endpoint_session_id);
    }
  });
}
