// RelayServer — orchestrates operator + endpoint sessions, dispatches
// inbound frames to the right handler, fans results back to operators.
//
// Designed transport-agnostic: takes `TransportHandle` instances (from
// session-store.ts), not raw WebSocket sockets. The actual `ws` library
// wiring lives in a separate ws-binding module to keep this file
// testable with mock transports.
//
// Responsibilities:
//   - Operator handshake: receive OperatorHello, verify HMAC, register
//     session, send OperatorHelloAck.
//   - Endpoint handshake: receive EndpointHello, verify connection_proof,
//     register session (replacing prior), send EndpointHelloAck.
//   - Operator frame dispatch: DispatchRequest / ConfirmRequest →
//     orchestrator → preview / envelope / errors back.
//   - Endpoint frame dispatch: CommandAck / ProgressEvent / CommandResult
//     / ErrorEvent → result router → operator events back.
//   - Lifecycle: start ACK timer on envelope-sent; cancel on ACK arrival.
//
// All state mutations go through the foundation modules (audit, lifecycle,
// session, nonce store) — this server is glue, not policy.

import { randomUUID } from "node:crypto";

import type {
  OperatorHello,
  OperatorHelloAck,
  EndpointHello,
  EndpointHelloAck,
  DispatchRequest,
  ConfirmRequest,
  CommandAck,
  CommandResult,
  ProgressEventEndpointSide,
  ErrorEventEndpointToRelay,
  ErrorEventRelayToOperator,
  ChangeSetPreview,
  CommandEnvelope,
  Operator,
} from "./types.js";
import type { TransportHandle, SessionStore } from "./session-store.js";
import type { DispatchOrchestrator } from "./dispatch.js";
import type { ResultRouter } from "./result-router.js";
import type { AckTimeoutManager } from "./ack-timeout.js";
import type { AuditLog } from "./audit.js";
import { verifyOperatorHmac, verifyConnectionProof } from "./verification.js";

// ---------------------------------------------------------------------------

export interface RelayServerOptions {
  audit: AuditLog;
  sessions: SessionStore;
  dispatch: DispatchOrchestrator;
  router: ResultRouter;
  ackTimeout: AckTimeoutManager;
  /** Look up an operator's HMAC key by (operator_id, tenant_id). Returns
   *  null if operator not registered. */
  operatorHmacKey: (
    operator_id: string,
    tenant_id: string,
  ) => Uint8Array | null;
  /** Look up an endpoint's Ed25519 public key by endpoint_id. Returns null
   *  if endpoint not enrolled. */
  endpointPublicKey: (endpoint_id: string) => Uint8Array | null;
  /** Now provider for testability. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------

interface OperatorInflight {
  operator_session_id: string;
  request_id: string;
  command_id: string;
  preview_hash: string;
  request: DispatchRequest;
  request_bytes: Uint8Array;
}

export class RelayServer {
  private readonly opts: RelayServerOptions;
  private readonly now: () => Date;
  /** request_id → operator-side dispatch state awaiting ConfirmRequest */
  private readonly pendingByRequestId = new Map<string, OperatorInflight>();

  constructor(opts: RelayServerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  // ----- operator session ---------------------------------------------------

  /**
   * Process an OperatorHello frame on a freshly-opened operator transport.
   * On success, registers the operator session. Returns the
   * OperatorHelloAck to send back. On failure, returns an ErrorEvent and
   * the caller should close the transport.
   */
  async acceptOperatorHello(args: {
    transport: TransportHandle;
    helloBytes: Uint8Array;
  }): Promise<
    | { ok: true; ack: OperatorHelloAck; operator_session_id: string }
    | { ok: false; error: ErrorEventRelayToOperator }
  > {
    let hello: OperatorHello;
    try {
      hello = parseFrame<OperatorHello>(args.helloBytes, "OperatorHello");
    } catch (e) {
      return {
        ok: false,
        error: this.makeOperatorError(
          "(no-request-id)",
          null,
          "AUTH_MALFORMED",
          `OperatorHello parse failure: ${(e as Error).message}`,
        ),
      };
    }

    // For OperatorHello, the auth_proof is over the OperatorHello frame
    // itself. We need an HMAC key — looked up from operator_id+tenant_id.
    const hmacKey = this.opts.operatorHmacKey(
      hello.operator.id,
      hello.tenant_id,
    );
    if (hmacKey === null) {
      return {
        ok: false,
        error: this.makeOperatorError(
          "(no-request-id)",
          null,
          "AUTH_INVALID_PROOF",
          `Unknown operator/tenant: ${hello.operator.id}/${hello.tenant_id}`,
        ),
      };
    }

    // Verify HMAC over the hello payload (treats the hello as a request
    // with auth_proof.signature on the operator field).
    const verifyResult = verifyOperatorHmac({
      request: hello as unknown as Record<string, unknown>,
      hmacKey,
    });
    if (!verifyResult.ok) {
      return {
        ok: false,
        error: this.makeOperatorError(
          "(no-request-id)",
          null,
          verifyResult.code,
          verifyResult.message,
        ),
      };
    }

    const operator_session_id = randomUUID();
    this.opts.sessions.registerOperator({
      operator_session_id,
      operator: hello.operator,
      tenant_id: hello.tenant_id,
      opened_at: this.now().toISOString(),
      transport: args.transport,
      inflight_request_ids: new Set(),
    });

    const ack: OperatorHelloAck = {
      type: "OperatorHelloAck",
      operator_session_id,
      server_protocol_version: "v1",
      ts: this.now().toISOString(),
    };
    return { ok: true, ack, operator_session_id };
  }

  /**
   * Handle a parsed DispatchRequest from an operator session. Returns the
   * ChangeSetPreview to send back to the operator on success, or an
   * ErrorEvent on failure.
   *
   * Caller is responsible for sending the returned frame back to the
   * operator. State is recorded internally so a subsequent ConfirmRequest
   * can complete the dispatch via handleConfirmRequest().
   */
  async handleDispatchRequest(args: {
    operator_session_id: string;
    request: DispatchRequest;
    request_bytes: Uint8Array;
  }): Promise<
    | { ok: true; preview: ChangeSetPreview }
    | { ok: false; error: ErrorEventRelayToOperator }
  > {
    const session = this.opts.sessions.getOperator(args.operator_session_id);
    if (session === undefined) {
      return {
        ok: false,
        error: this.makeOperatorError(
          args.request.request_id,
          null,
          "AUTH_INVALID_PROOF",
          "Operator session not found",
        ),
      };
    }
    const begin = await this.opts.dispatch.beginDispatch({
      operator_session_id: args.operator_session_id,
      operator: session.operator,
      tenant_id: session.tenant_id,
      request_bytes: args.request_bytes,
      request: args.request,
    });
    if (!begin.ok) {
      return { ok: false, error: begin.error };
    }
    // Record pending state awaiting ConfirmRequest
    this.pendingByRequestId.set(args.request.request_id, {
      operator_session_id: args.operator_session_id,
      request_id: args.request.request_id,
      command_id: begin.command_id,
      preview_hash: begin.preview.preview_hash,
      request: args.request,
      request_bytes: args.request_bytes,
    });
    session.inflight_request_ids.add(args.request.request_id);
    return { ok: true, preview: begin.preview };
  }

  /**
   * Handle a ConfirmRequest from an operator. On success, returns the
   * signed CommandEnvelope to send to the endpoint AND the
   * endpoint_session_id of the receiving endpoint. Caller is responsible
   * for actually sending the envelope and starting the ACK timer (this
   * function handles the timer-start internally as a convenience but
   * does NOT send the envelope — that's transport-layer work).
   *
   * On failure, returns an ErrorEvent for the operator.
   */
  async handleConfirmRequest(args: {
    operator_session_id: string;
    confirm: ConfirmRequest;
  }): Promise<
    | {
        ok: true;
        envelope: CommandEnvelope;
        endpoint_transport: TransportHandle;
        command_id: string;
      }
    | { ok: false; error: ErrorEventRelayToOperator }
  > {
    const pending = this.pendingByRequestId.get(args.confirm.request_id);
    if (pending === undefined) {
      return {
        ok: false,
        error: this.makeOperatorError(
          args.confirm.request_id,
          args.confirm.command_id,
          "RELAY_INTERNAL_ERROR",
          "ConfirmRequest received without prior DispatchRequest in session",
        ),
      };
    }
    if (pending.operator_session_id !== args.operator_session_id) {
      return {
        ok: false,
        error: this.makeOperatorError(
          args.confirm.request_id,
          args.confirm.command_id,
          "AUTH_INVALID_PROOF",
          "ConfirmRequest from different operator session than DispatchRequest",
        ),
      };
    }
    if (pending.command_id !== args.confirm.command_id) {
      return {
        ok: false,
        error: this.makeOperatorError(
          args.confirm.request_id,
          args.confirm.command_id,
          "RELAY_INTERNAL_ERROR",
          "ConfirmRequest command_id does not match issued command_id",
        ),
      };
    }
    const endpointSession = this.opts.sessions.getActiveEndpointSession(
      pending.request.target_endpoint_id,
    );
    if (endpointSession === undefined) {
      this.cleanupPending(pending);
      return {
        ok: false,
        error: this.makeOperatorError(
          args.confirm.request_id,
          args.confirm.command_id,
          "RELAY_ENDPOINT_UNREACHABLE",
          "Endpoint disconnected between DispatchRequest and ConfirmRequest",
        ),
      };
    }
    const result = await this.opts.dispatch.produceEnvelope({
      request: pending.request,
      confirm: args.confirm,
      command_id: pending.command_id,
      expected_preview_hash: pending.preview_hash,
      target_session_id: endpointSession.session_id,
    });
    if (!result.ok) {
      this.cleanupPending(pending);
      return { ok: false, error: result.error };
    }

    // Register inflight in the result router so endpoint frames fan out
    this.opts.router.registerInflight({
      command_id: pending.command_id,
      request_id: pending.request_id,
      operator_session_id: pending.operator_session_id,
      endpoint_id: pending.request.target_endpoint_id,
      endpoint_session_id: endpointSession.session_id,
      dispatch_request: { tool: pending.request.tool },
    });
    endpointSession.inflight_command_ids.add(pending.command_id);

    this.cleanupPending(pending);
    return {
      ok: true,
      envelope: result.envelope,
      endpoint_transport: endpointSession.transport,
      command_id: pending.command_id,
    };
  }

  /**
   * Caller invokes this after successfully WS-writing the CommandEnvelope.
   * Starts the T_ACK_TIMEOUT timer; if it fires, fan an ENDPOINT_NO_ACK
   * ErrorEvent back to the operator.
   */
  startAckTimer(command_id: string): void {
    this.opts.ackTimeout.start(command_id, (cid) => {
      const result = this.opts.router.handleAckTimeout(cid);
      if (result.kind === "operator_event") {
        this.fanoutToOperator(
          result.target_operator_session_id,
          result.frame,
        ).catch(() => {
          // Operator may have disconnected; best-effort
        });
      } else if (result.kind === "error") {
        this.fanoutToOperator(
          result.target_operator_session_id,
          result.error,
        ).catch(() => {});
      }
    });
  }

  // ----- endpoint session ---------------------------------------------------

  /**
   * Process an EndpointHello frame on a freshly-opened endpoint transport.
   * Verifies the connection_proof Ed25519 signature against the stored
   * endpoint public key. On success, registers (replacing any prior
   * session for the same endpoint_id) and returns the EndpointHelloAck.
   */
  async acceptEndpointHello(args: {
    transport: TransportHandle;
    hello: EndpointHello;
  }): Promise<
    | { ok: true; ack: EndpointHelloAck; session_id: string }
    | { ok: false; code: string; message: string }
  > {
    const pubKey = this.opts.endpointPublicKey(args.hello.endpoint_id);
    if (pubKey === null) {
      return {
        ok: false,
        code: "ENDPOINT_NOT_ENROLLED",
        message: `endpoint_id ${args.hello.endpoint_id} not registered`,
      };
    }
    const verifyResult = await verifyConnectionProof({
      endpoint_id: args.hello.endpoint_id,
      tenant_id: args.hello.tenant_id,
      proof: args.hello.connection_proof,
      endpointPublicKey: pubKey,
      now: this.now,
    });
    if (!verifyResult.ok) {
      return {
        ok: false,
        code: verifyResult.code,
        message: verifyResult.message,
      };
    }
    const session_id = randomUUID();
    const prior = this.opts.sessions.registerEndpoint({
      session_id,
      endpoint_id: args.hello.endpoint_id,
      tenant_id: args.hello.tenant_id,
      opened_at: this.now().toISOString(),
      transport: args.transport,
      inflight_command_ids: new Set(),
    });
    if (prior !== null) {
      // Prior session's inflight commands transition to failed via the
      // router's session-stale rejection on subsequent frames. The audit
      // entries already record dispatched-but-no-result; relay-side
      // deadline timers will eventually mark them timed_out if they never
      // resolve. Best-effort close of prior transport.
      prior.transport.close("replaced by reconnect").catch(() => {});
    }
    const ack: EndpointHelloAck = {
      type: "EndpointHelloAck",
      session_id,
      server_protocol_version: "v1",
      ts: this.now().toISOString(),
    };
    return { ok: true, ack, session_id };
  }

  /**
   * Handle a CommandAck from an endpoint. Cancels the ACK timer.
   * Forwards to operator as ProgressEvent { lifecycle_state: "started" }.
   */
  async handleEndpointCommandAck(ack: CommandAck): Promise<void> {
    this.opts.ackTimeout.cancel(ack.command_id);
    const result = this.opts.router.handleCommandAck(ack);
    await this.dispatchRouting(result);
  }

  async handleEndpointProgressEvent(
    evt: ProgressEventEndpointSide,
  ): Promise<void> {
    const result = this.opts.router.handleProgressEvent(evt);
    await this.dispatchRouting(result);
  }

  async handleEndpointCommandResult(result: CommandResult): Promise<void> {
    const r = this.opts.router.handleCommandResult(result);
    await this.dispatchRouting(r);
  }

  async handleEndpointErrorEvent(
    err: ErrorEventEndpointToRelay,
  ): Promise<void> {
    // Endpoint reject-before-start (signature invalid, expired, etc.)
    // also cancels the ACK timer if pending.
    this.opts.ackTimeout.cancel(err.command_id);
    const r = this.opts.router.handleEndpointError(err);
    await this.dispatchRouting(r);
  }

  /**
   * Dispatch a router result to the appropriate operator transport, or
   * silently drop if no operator event is owed (no_inflight / ack_only).
   */
  private async dispatchRouting<F>(
    result: import("./result-router.js").RoutingResult<F>,
  ): Promise<void> {
    if (result.kind === "operator_event") {
      await this.fanoutToOperator(
        result.target_operator_session_id,
        result.frame as object,
      );
    } else if (result.kind === "error") {
      await this.fanoutToOperator(
        result.target_operator_session_id,
        result.error,
      );
    }
    // no_inflight, ack_only — silently drop
  }

  // ----- internals ----------------------------------------------------------

  /**
   * Send a frame to a specific operator session's transport. If the
   * session is no longer registered (operator disconnected) or the
   * transport is not alive, the frame is dropped — this is correct;
   * audit log already records the event with channel-of-origin and
   * the operator can replay history if needed.
   */
  private async fanoutToOperator(
    operator_session_id: string,
    frame: object,
  ): Promise<void> {
    const session = this.opts.sessions.getOperator(operator_session_id);
    if (session === undefined) {
      return; // operator disconnected; drop
    }
    if (!session.transport.isAlive()) {
      return; // transport closed; drop
    }
    try {
      await session.transport.send(frame);
    } catch {
      // Transport may have failed mid-send; drop. Best-effort.
    }
  }

  private cleanupPending(pending: OperatorInflight): void {
    this.pendingByRequestId.delete(pending.request_id);
    const session = this.opts.sessions.getOperator(pending.operator_session_id);
    if (session !== undefined) {
      session.inflight_request_ids.delete(pending.request_id);
    }
  }

  private makeOperatorError(
    request_id: string,
    command_id: string | null,
    code: string,
    message: string,
  ): ErrorEventRelayToOperator {
    return {
      type: "ErrorEvent",
      request_id,
      command_id,
      code,
      message,
      ts: this.now().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------

function parseFrame<T extends { type: string }>(
  bytes: Uint8Array,
  expectedType: string,
): T {
  const text = new TextDecoder().decode(bytes);
  const obj = JSON.parse(text) as T;
  if (obj.type !== expectedType) {
    throw new Error(
      `Expected frame type "${expectedType}"; got "${(obj as { type: string }).type}"`,
    );
  }
  return obj;
}
