/**
 * Brainstorm A2A Protocol v0.1 — wire types.
 *
 * Implements the canonical spec at /docs/a2a-protocol-v01.md. Agents invoke
 * each other through BrainstormRouter mesh-auth via POST /v1/mesh/invoke/{target_did}.
 *
 * Three response shapes:
 *   - 200 OK    — synchronous completion
 *   - 202 Accepted — async, caller polls status_url
 *   - 4xx/5xx   — typed error envelope aligned with Platform Contract v1 codes
 */

/** Request body for POST /v1/mesh/invoke/{target_did}. */
export interface A2AInvokeRequest {
  /** Caller-generated UUID, unique per logical task. */
  task_id: string;
  /** Capability name in the agent.<verb>_<noun> namespace. */
  capability: string;
  /** Payload validated against the registered input_schema. */
  input: unknown;
  /** Caller's deadline (ISO 8601). Receivers SHOULD reject if they can't meet it. */
  deadline_iso?: string;
}

/** Successful synchronous response body. */
export interface A2AInvokeSyncResponse {
  task_id: string;
  output: unknown;
  evidence_envelope_hash: string;
  completed_at: string;
  /** W3C traceparent propagated unchanged from request. */
  traceparent: string;
}

/** Successful async response body (202 Accepted). */
export interface A2AInvokeAsyncResponse {
  task_id: string;
  status_url: string;
  traceparent: string;
}

/**
 * Canonical Platform Contract v1 error envelope.
 *
 * Spec at /docs/platform-contract-v1.md mandates {success:false, error:{code, message}}.
 * A2A-specific top-level extensions (e.g. task_id on CONFLICT, retry_after_seconds
 * on RATE_LIMITED) ride alongside; callers route on error.code only.
 */
export interface A2AErrorEnvelope {
  success: false;
  error: {
    code: A2AErrorCode;
    message: string;
  };
  /** Original task_id from first acceptance, populated when code=CONFLICT
   *  (duplicate Idempotency-Key). */
  task_id?: string;
  /** Seconds until the caller may retry, set when code=RATE_LIMITED.
   *  The HTTP `Retry-After` response header carries the same value. */
  retry_after_seconds?: number;
}

/** Closed enum of A2A error codes — aligned with Platform Contract v1. */
export type A2AErrorCode =
  | "VALIDATION"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "GONE"
  | "INVARIANT"
  | "INTERNAL"
  | "UNAVAILABLE";

/** Async task lifecycle states. */
export type TaskState =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "expired";

/** Persistence shape for async tasks (status_url responses). */
export interface TaskRecord {
  task_id: string;
  state: TaskState;
  caller_did: string;
  target_did: string;
  capability: string;
  traceparent: string;
  tracestate?: string;
  accepted_at: string;
  completed_at?: string;
  /** Set when state is completed/failed. */
  result?: A2AInvokeSyncResponse;
  /** Set when state is failed. */
  failure?: A2AErrorEnvelope;
  /** Hard expiry — task is GONE after this even if not completed. */
  expires_at: string;
}

/** Decoded W3C traceparent header. */
export interface TraceContext {
  version: string; // "00"
  trace_id: string; // 32-hex
  span_id: string; // 16-hex
  flags: string; // 2-hex
}

/** Per-agent JWT claims (issued by /v1/agent/bootstrap). */
export interface AgentJWTClaims {
  /** Caller's lineage DID — did:bvm:<tenant>:<agent>. */
  sub: string;
  tenant_id: string;
  /** Capability names this agent is authorized to INVOKE on peers. */
  capabilities: string[];
  /** Optional signing-key identifier for rotation. */
  key_id?: string;
  iat?: number;
  exp?: number;
}
