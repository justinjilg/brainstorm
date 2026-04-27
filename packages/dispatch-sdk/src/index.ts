// @brainst0rm/dispatch-sdk — programmatic dispatch primitive for
// autonomous-agent operators (P1.7).
//
// Usage (autonomous Claude agent):
//
//   import { Dispatcher } from "@brainst0rm/dispatch-sdk";
//
//   const dispatcher = new Dispatcher({
//     relayUrl: "wss://relay.example.com",
//     apiKey: process.env.BRAINSTORM_AGENT_API_KEY!,
//     agentId: "agent-soul-abc",
//     parentHumanId: "alice@example.com",
//     tenantId: "tenant-1",
//   });
//
//   await dispatcher.connect();
//   const result = await dispatcher.dispatch({
//     tool: "echo",
//     params: { message: "hello" },
//     targetEndpointId: "ep-1",
//     autoConfirm: true,
//   });
//   console.log(result.payload.stdout);
//
//   await dispatcher.close();
//
// Streaming progress:
//
//   const stream = dispatcher.dispatchStreaming({ ... });
//   for await (const event of stream) {
//     if (event.kind === "progress") console.log(event.fraction, event.message);
//     else if (event.kind === "result") return event.payload;
//   }

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { deriveOperatorHmacKey, operatorHmac } from "@brainst0rm/relay";

// ---------------------------------------------------------------------------

export interface DispatcherOptions {
  /** Relay base URL, e.g. "wss://relay.example.com" or "ws://127.0.0.1:8443". */
  relayUrl: string;
  /** Agent API key issued by relay during agent provisioning. */
  apiKey: string;
  /** Agent SOUL id (per project_br_agent_identity.md). */
  agentId: string;
  /** Root human in the dispatch chain (for audit traceability). */
  parentHumanId: string;
  /** Tenant scope. */
  tenantId: string;
  /** Optional intermediate parent for chain depth >2. */
  delegatingPrincipalId?: string;
  /** Default deadline for dispatches in milliseconds (default 30s). */
  defaultDeadlineMs?: number;
}

export interface DispatchInput {
  tool: string;
  params: Record<string, unknown>;
  targetEndpointId: string;
  /** If true, skip ChangeSetPreview confirmation prompt. Defaults to true for SDK. */
  autoConfirm?: boolean;
  /** Operator deadline override. */
  deadlineMs?: number;
  /** Cross-product correlation id (e.g. tying back to a BR request_id). */
  correlationId?: string;
  /** Whether to receive ProgressEvents (default true). */
  streamProgress?: boolean;
}

export interface DispatchResult {
  command_id: string;
  request_id: string;
  status: "completed" | "failed" | "timed_out";
  payload?: { stdout?: string; stderr?: string; exit_code?: number };
  error?: { code: string; message: string };
  evidence_hash?: string;
}

export type ProgressStreamEvent =
  | {
      kind: "preview";
      command_id: string;
      preview_summary: string;
      preview_hash: string;
    }
  | {
      kind: "progress";
      command_id: string;
      lifecycle_state: string;
      fraction?: number;
      message?: string;
    }
  | { kind: "result"; result: DispatchResult }
  | { kind: "error"; code: string; message: string };

// ---------------------------------------------------------------------------

export class Dispatcher {
  private readonly opts: DispatcherOptions;
  private readonly hmacKey: Uint8Array;
  private ws: WebSocket | null = null;
  private inboundBuffer: Frame[] = [];
  private waiters: Array<(f: Frame) => void> = [];
  private closed = false;

  constructor(opts: DispatcherOptions) {
    this.opts = opts;
    this.hmacKey = deriveOperatorHmacKey({
      apiKey: opts.apiKey,
      operatorId: opts.agentId,
      tenantId: opts.tenantId,
    });
  }

  /**
   * Open the persistent WS connection to the relay and complete the
   * OperatorHello handshake.
   */
  async connect(): Promise<void> {
    if (this.ws !== null) {
      throw new Error("Dispatcher already connected");
    }
    this.ws = new WebSocket(this.opts.relayUrl + "/v1/operator");
    await new Promise<void>((resolve, reject) => {
      this.ws!.once("open", () => resolve());
      this.ws!.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const text =
        data instanceof Buffer ? data.toString("utf-8") : String(data);
      let frame: Frame;
      try {
        frame = JSON.parse(text) as Frame;
      } catch {
        return;
      }
      const w = this.waiters.shift();
      if (w !== undefined) w(frame);
      else this.inboundBuffer.push(frame);
    });
    this.ws.on("close", () => {
      this.closed = true;
      this.failAllWaiters(new Error("WebSocket closed"));
    });
    this.ws.on("error", () => {
      this.closed = true;
      this.failAllWaiters(new Error("WebSocket error"));
    });

    // Send OperatorHello (agent class)
    const hello = this.signOperatorHello();
    await this.send(hello);
    const helloAck = await this.next();
    if (helloAck.type !== "OperatorHelloAck") {
      throw new Error(
        `Expected OperatorHelloAck; got ${helloAck.type}: ${JSON.stringify(helloAck)}`,
      );
    }
  }

  /**
   * Dispatch a tool and wait for the terminal result. Skips streaming
   * intermediate ProgressEvents — for streaming, use dispatchStreaming.
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const stream = this.dispatchStreaming(input);
    for await (const event of stream) {
      if (event.kind === "result") return event.result;
      if (event.kind === "error") {
        return {
          command_id: "(unknown)",
          request_id: "(unknown)",
          status: "failed",
          error: { code: event.code, message: event.message },
        };
      }
    }
    throw new Error("dispatch stream ended without result");
  }

  /**
   * Async iterable that yields preview/progress/result events as they
   * arrive. Caller can render progress to a UI or filter to terminal.
   */
  async *dispatchStreaming(
    input: DispatchInput,
  ): AsyncGenerator<ProgressStreamEvent, void, void> {
    if (this.ws === null || this.closed) {
      throw new Error("Dispatcher not connected");
    }

    const requestId = randomUUID();
    const correlationId = input.correlationId ?? "corr-" + requestId;
    const dispatchReq = this.signDispatchRequest({
      requestId,
      correlationId,
      input,
    });
    await this.send(dispatchReq);

    // Receive preview
    const previewFrame = await this.next();
    if (previewFrame.type === "ErrorEvent") {
      const e = previewFrame as unknown as { code: string; message: string };
      yield { kind: "error", code: e.code, message: e.message };
      return;
    }
    if (previewFrame.type !== "ChangeSetPreview") {
      yield {
        kind: "error",
        code: "PROTOCOL_ERROR",
        message: `Expected ChangeSetPreview, got ${previewFrame.type}`,
      };
      return;
    }
    const preview = previewFrame as unknown as {
      request_id: string;
      command_id: string;
      preview_summary: string;
      preview_hash: string;
    };
    yield {
      kind: "preview",
      command_id: preview.command_id,
      preview_summary: preview.preview_summary,
      preview_hash: preview.preview_hash,
    };

    // Auto-confirm by default for SDK; explicit confirm: false would error
    const autoConfirm = input.autoConfirm !== false; // default true
    await this.send({
      type: "ConfirmRequest",
      request_id: preview.request_id,
      command_id: preview.command_id,
      preview_hash: preview.preview_hash,
      confirm: autoConfirm,
    });

    if (!autoConfirm) {
      // Operator declined — relay will emit OPERATOR_DECLINED
      const declined = await this.next();
      if (declined.type === "ErrorEvent") {
        const e = declined as unknown as { code: string; message: string };
        yield { kind: "error", code: e.code, message: e.message };
      }
      return;
    }

    // Stream events until terminal
    while (true) {
      const frame = await this.next();
      if (frame.type === "ProgressEvent") {
        const p = frame as unknown as {
          command_id: string;
          lifecycle_state: string;
          progress?: { fraction?: number; message?: string };
        };
        yield {
          kind: "progress",
          command_id: p.command_id,
          lifecycle_state: p.lifecycle_state,
          fraction: p.progress?.fraction,
          message: p.progress?.message,
        };
      } else if (frame.type === "ResultEvent") {
        const r = frame as unknown as {
          command_id: string;
          request_id: string;
          lifecycle_state: "completed" | "failed" | "timed_out";
          payload?: {
            stdout?: string;
            stderr?: string;
            exit_code?: number;
          } | null;
          error?: { code: string; message: string } | null;
          evidence_hash?: string;
        };
        yield {
          kind: "result",
          result: {
            command_id: r.command_id,
            request_id: r.request_id,
            status: r.lifecycle_state,
            payload: r.payload ?? undefined,
            error: r.error ?? undefined,
            evidence_hash: r.evidence_hash,
          },
        };
        return;
      } else if (frame.type === "ErrorEvent") {
        const e = frame as unknown as { code: string; message: string };
        yield { kind: "error", code: e.code, message: e.message };
        return;
      }
      // Unknown frame type — ignore
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ws !== null) {
      try {
        this.ws.close(1000, "dispatcher closed");
      } catch {}
      this.ws = null;
    }
    this.failAllWaiters(new Error("Dispatcher closed"));
  }

  isConnected(): boolean {
    return this.ws !== null && !this.closed;
  }

  // --- internals ----------------------------------------------------------

  private send(frame: object): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws === null) {
        reject(new Error("not connected"));
        return;
      }
      this.ws.send(JSON.stringify(frame), (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  private next(): Promise<Frame> {
    if (this.closed) {
      return Promise.reject(new Error("Dispatcher closed"));
    }
    const buffered = this.inboundBuffer.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    return new Promise<Frame>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private failAllWaiters(err: Error): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      // We can't actually reject from a resolve-only signature; instead
      // push a synthetic error frame so the consumer surfaces the failure.
      w({
        type: "ErrorEvent",
        request_id: "(connection-closed)",
        command_id: null,
        code: "CONNECTION_CLOSED",
        message: err.message,
      } as unknown as Frame);
    }
  }

  private signOperatorHello(): object {
    const hello = {
      type: "OperatorHello",
      operator: {
        kind: "agent" as const,
        id: this.opts.agentId,
        auth_proof: { kind: "hmac_signed_envelope" as const, signature: "" },
        originating_human_id: this.opts.parentHumanId,
        ...(this.opts.delegatingPrincipalId !== undefined
          ? { delegating_principal_id: this.opts.delegatingPrincipalId }
          : {}),
      },
      tenant_id: this.opts.tenantId,
      client_protocol_version: "v1" as const,
    };
    const digest = operatorHmac(
      hello as unknown as Record<string, unknown>,
      this.hmacKey,
    );
    hello.operator.auth_proof.signature = bytesToBase64(digest);
    return hello;
  }

  private signDispatchRequest(args: {
    requestId: string;
    correlationId: string;
    input: DispatchInput;
  }): object {
    const req = {
      type: "DispatchRequest" as const,
      request_id: args.requestId,
      tool: args.input.tool,
      params: args.input.params,
      target_endpoint_id: args.input.targetEndpointId,
      tenant_id: this.opts.tenantId,
      correlation_id: args.correlationId,
      operator: {
        kind: "agent" as const,
        id: this.opts.agentId,
        auth_proof: { kind: "hmac_signed_envelope" as const, signature: "" },
        originating_human_id: this.opts.parentHumanId,
        ...(this.opts.delegatingPrincipalId !== undefined
          ? { delegating_principal_id: this.opts.delegatingPrincipalId }
          : {}),
      },
      options: {
        auto_confirm: args.input.autoConfirm ?? true,
        stream_progress: args.input.streamProgress ?? true,
        deadline_ms:
          args.input.deadlineMs ?? this.opts.defaultDeadlineMs ?? 30_000,
      },
    };
    const digest = operatorHmac(
      req as unknown as Record<string, unknown>,
      this.hmacKey,
    );
    req.operator.auth_proof.signature = bytesToBase64(digest);
    return req;
  }
}

// ---------------------------------------------------------------------------

interface Frame {
  type: string;
  [key: string]: unknown;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return Buffer.from(s, "binary").toString("base64");
}
