// In-memory session registry per protocol-v1 §11 (connection lifecycle).
//
// Tracks two distinct session classes:
//
//   - OperatorSession: short-lived (per-dispatch CLI) or persistent (SDK).
//     Identified by operator_session_id. Keyed by session_id; one operator
//     may have multiple concurrent sessions.
//
//   - EndpointSession: long-lived persistent outbound from endpoint.
//     Identified by session_id. AT MOST ONE active session per endpoint_id;
//     reconnects invalidate the prior session_id (per F12 fix).
//
// The store carries opaque "transport handles" — references to the WS
// connection or test stub — so that dispatch can fan results back to the
// originating operator without the relay having to know transport details.

import type { Operator } from "./types.js";

export type TransportHandle = {
  /** Send a frame; opaque to the store. Returns when frame is queued. */
  send(frame: unknown): Promise<void>;
  /** Best-effort close. Idempotent. */
  close(reason?: string): Promise<void>;
  /** Whether the transport is currently writable. */
  isAlive(): boolean;
};

export interface OperatorSession {
  operator_session_id: string;
  operator: Operator;
  tenant_id: string;
  opened_at: string;
  transport: TransportHandle;
  /** in-flight dispatch request_ids issued by this operator session */
  inflight_request_ids: Set<string>;
}

export interface EndpointSession {
  session_id: string;
  endpoint_id: string;
  tenant_id: string;
  opened_at: string;
  transport: TransportHandle;
  /** in-flight command_ids dispatched to this endpoint */
  inflight_command_ids: Set<string>;
}

export class SessionStore {
  private readonly operators = new Map<string, OperatorSession>();
  private readonly endpoints = new Map<string, EndpointSession>();
  /** endpoint_id → current session_id; allows stale-session detection */
  private readonly endpointToSession = new Map<string, string>();

  // --- operator sessions ---------------------------------------------------

  registerOperator(session: OperatorSession): void {
    if (this.operators.has(session.operator_session_id)) {
      throw new Error(
        `SessionStore: operator_session_id already registered: ${session.operator_session_id}`,
      );
    }
    this.operators.set(session.operator_session_id, session);
  }

  getOperator(operator_session_id: string): OperatorSession | undefined {
    return this.operators.get(operator_session_id);
  }

  removeOperator(operator_session_id: string): void {
    this.operators.delete(operator_session_id);
  }

  // --- endpoint sessions ---------------------------------------------------

  /**
   * Register a new endpoint session. If endpoint_id already has an active
   * session, the prior session is REPLACED (its transport closed) — this
   * implements the "reconnect invalidates prior session_id" rule from
   * protocol §11. The replaced session's in-flight commands transition
   * to `failed` with `RELAY_ENDPOINT_DISCONNECTED_BEFORE_ACK` — the caller
   * is responsible for performing those state transitions before calling
   * registerEndpoint() with the new session.
   *
   * Returns the prior session that was replaced, if any. Caller may want
   * to inspect its `inflight_command_ids` to drive transition logic.
   */
  registerEndpoint(session: EndpointSession): EndpointSession | null {
    if (this.endpoints.has(session.session_id)) {
      throw new Error(
        `SessionStore: session_id already registered: ${session.session_id}`,
      );
    }
    const priorSessionId = this.endpointToSession.get(session.endpoint_id);
    let prior: EndpointSession | null = null;
    if (priorSessionId !== undefined) {
      prior = this.endpoints.get(priorSessionId) ?? null;
      this.endpoints.delete(priorSessionId);
    }
    this.endpoints.set(session.session_id, session);
    this.endpointToSession.set(session.endpoint_id, session.session_id);
    return prior;
  }

  getEndpoint(session_id: string): EndpointSession | undefined {
    return this.endpoints.get(session_id);
  }

  /**
   * Get the current active session for a given endpoint_id, if any.
   * Used for routing relay→endpoint dispatches.
   */
  getActiveEndpointSession(endpoint_id: string): EndpointSession | undefined {
    const sid = this.endpointToSession.get(endpoint_id);
    if (sid === undefined) return undefined;
    return this.endpoints.get(sid);
  }

  /**
   * Check if a session_id is the CURRENTLY active session for the
   * endpoint that opened it. Used for stale-session detection on
   * incoming endpoint frames (per protocol §2 connection model).
   */
  isCurrentSession(endpoint_id: string, session_id: string): boolean {
    return this.endpointToSession.get(endpoint_id) === session_id;
  }

  removeEndpoint(session_id: string): EndpointSession | undefined {
    const session = this.endpoints.get(session_id);
    if (session === undefined) return undefined;
    this.endpoints.delete(session_id);
    // Only clear the endpoint→session mapping if THIS session was the
    // current one. If a newer session has already replaced it, leave the
    // mapping alone.
    if (this.endpointToSession.get(session.endpoint_id) === session_id) {
      this.endpointToSession.delete(session.endpoint_id);
    }
    return session;
  }

  // --- snapshot / debug ----------------------------------------------------

  countOperators(): number {
    return this.operators.size;
  }

  countEndpoints(): number {
    return this.endpoints.size;
  }

  /** All currently active endpoint_ids (one entry per active session). */
  activeEndpointIds(): string[] {
    return Array.from(this.endpointToSession.keys());
  }
}
