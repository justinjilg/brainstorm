// Wire types for the Brainstorm endpoint-agent dispatch protocol v3.
//
// Mirrors §13 JSON Schemas of docs/endpoint-agent-protocol-v1.md. Schema
// definitions are normative; these TypeScript types are derived for
// implementation convenience and must stay in sync.
//
// Lifecycle vocab (D29, federation-cheap with MSP correlation + BR
// routing-stream):
//   pending | dispatched | started | progress | completed | failed | timed_out

export type LifecycleState =
  | "pending"
  | "dispatched"
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "timed_out";

// VMM API state — common vocabulary across CHV (Linux) + VF (macOS); each
// backend translates from native state at impl boundary (TM-Touchpoint-1).
export type VmmApiState = "running" | "stopped" | "paused" | "error";

// Channel-of-origin — stamped on AuditLogEntry, NOT on wire frames (F1 fix).
export type ChannelOfOrigin =
  | "operator"
  | "relay-internal"
  | "endpoint"
  | "sandbox";

// --- Operator class envelope (D11 v3.1 refinement) ------------------------

export type AuthProof =
  | { mode: "hmac"; signature: string }
  | { mode: "jwt"; token: string }
  | { mode: "caf_mtls"; cert_fingerprint: string };

export interface OperatorHuman {
  kind: "human";
  id: string;
  auth_proof: AuthProof;
  originating_human_id?: string;
  delegating_principal_id?: string;
}

export interface OperatorAgent {
  kind: "agent";
  id: string;
  auth_proof: AuthProof;
  originating_human_id: string; // mandatory for agent class
  delegating_principal_id?: string;
}

export type Operator = OperatorHuman | OperatorAgent;

// --- Operator → Relay frames ----------------------------------------------

export interface OperatorHello {
  type: "OperatorHello";
  operator: Operator;
  tenant_id: string;
  client_protocol_version: "v1";
  session_token_request?: boolean;
}

export interface OperatorHelloAck {
  type: "OperatorHelloAck";
  operator_session_id: string;
  server_protocol_version: "v1";
  ts: string;
}

export interface DispatchRequest {
  type: "DispatchRequest";
  request_id: string;
  tool: string;
  params: Record<string, unknown>;
  target_endpoint_id: string;
  tenant_id: string;
  correlation_id: string; // mandatory per D28
  operator: Operator;
  options: {
    auto_confirm: boolean;
    stream_progress: boolean;
    deadline_ms: number; // 1000 .. 600000
  };
}

export interface ChangeSetPreview {
  type: "ChangeSetPreview";
  request_id: string;
  command_id: string;
  preview_summary: string;
  preview_hash: string; // sha256:... — binds ConfirmRequest to this preview (F16)
  blast_radius: "low" | "medium" | "high" | "destructive";
  reversibility: "trivial" | "moderate" | "difficult" | "irreversible";
}

export interface ConfirmRequest {
  type: "ConfirmRequest";
  request_id: string;
  command_id: string;
  preview_hash: string; // must echo the ChangeSetPreview's preview_hash
  confirm: boolean;
}

export interface ProgressEventOperatorSide {
  type: "ProgressEvent";
  request_id: string;
  command_id: string;
  lifecycle_state: LifecycleState;
  progress?: { fraction: number; message: string };
  ts: string; // ISO8601
}

export interface ResultEvent {
  type: "ResultEvent";
  request_id: string;
  command_id: string;
  lifecycle_state: "completed" | "failed" | "timed_out";
  payload?: Record<string, unknown> | null;
  error?: { code: string; message: string } | null;
  evidence_hash?: string; // sha256:...
  ts: string;
}

export interface ErrorEventRelayToOperator {
  type: "ErrorEvent";
  request_id: string;
  command_id: string | null;
  code: string;
  message: string;
  ts: string;
}

export type OperatorRelayFrame =
  | OperatorHello
  | OperatorHelloAck
  | DispatchRequest
  | ConfirmRequest
  | ChangeSetPreview
  | ProgressEventOperatorSide
  | ResultEvent
  | ErrorEventRelayToOperator;

// --- Relay → Endpoint frames ----------------------------------------------

export interface EndpointHello {
  type: "EndpointHello";
  endpoint_id: string;
  tenant_id: string;
  agent_version: string;
  agent_protocol_version: "v1";
  connection_proof: {
    ts: string;
    signature: string; // ed25519 over (CONNECTION_PROOF prefix || JCS({endpoint_id, tenant_id, ts}))
  };
}

export interface EndpointHelloAck {
  type: "EndpointHelloAck";
  session_id: string;
  server_protocol_version: "v1";
  ts: string;
}

export interface CommandEnvelope {
  type: "CommandEnvelope";
  command_id: string;
  tenant_id: string;
  target_endpoint_id: string; // signed; cross-endpoint replay defense (F5)
  correlation_id: string; // mandatory (F2)
  session_id: string; // endpoint connection epoch (F12)
  tool: string;
  params: Record<string, unknown>;
  operator: Omit<Operator, "auth_proof">; // auth_proof stripped before relay→endpoint
  lifecycle_state: "dispatched";
  issued_at: string;
  expires_at: string;
  nonce: string; // 32 bytes base64url
  signing_key_id: string;
  signature_algo: "ed25519-jcs-sha256-v1";
  signature: string; // base64 Ed25519 signature
}

export interface CommandAck {
  type: "CommandAck";
  command_id: string;
  endpoint_id: string;
  session_id: string;
  track: "data_provider" | "mutator";
  will_emit_progress: boolean;
  estimated_duration_ms?: number | null; // optional per §13.4 schema
  ts: string;
}

// CommandResult is a discriminated union enforcing the lifecycle-dependent
// shape constraints from §13.3 oneOf. TypeScript narrows on lifecycle_state
// so handlers can rely on payload non-null when completed, error non-null
// when failed.

export interface CompletedCommandResult {
  type: "CommandResult";
  command_id: string;
  endpoint_id: string;
  session_id: string;
  lifecycle_state: "completed";
  payload: Record<string, unknown>;
  error?: null;
  evidence_hash: string;
  sandbox_reset_state: SandboxResetState; // required for completed
  resumed?: boolean;
  ts: string;
}

export interface FailedCommandResult {
  type: "CommandResult";
  command_id: string;
  endpoint_id: string;
  session_id: string;
  lifecycle_state: "failed";
  payload?: null;
  error: { code: string; message: string };
  evidence_hash: string;
  sandbox_reset_state?: SandboxResetState; // optional for failed
  resumed?: boolean;
  ts: string;
}

export type CommandResult = CompletedCommandResult | FailedCommandResult;

export interface SandboxResetState {
  reset_at: string;
  golden_hash: string;
  verification_passed: boolean;
  verification_details: VerificationDetails;
}

export interface VerificationDetails {
  fs_hash: string;
  fs_hash_baseline: string;
  fs_hash_match: boolean;
  open_fd_count: number;
  open_fd_count_baseline: number;
  vmm_api_state: VmmApiState;
  expected_vmm_api_state: VmmApiState;
  divergence_action: "none" | "halt";
}

export interface ProgressEventEndpointSide {
  type: "ProgressEvent";
  command_id: string;
  endpoint_id: string;
  session_id: string;
  lifecycle_state: "started" | "progress";
  seq: number;
  progress?: { fraction: number; message: string };
  ts: string;
}

export interface ErrorEventEndpointToRelay {
  type: "ErrorEvent";
  command_id: string;
  endpoint_id: string;
  session_id: string;
  code: string;
  message: string;
  ts: string;
}

export interface HealthPing {
  type: "HealthPing";
  session_id?: string; // endpoint→relay always; relay→endpoint may omit
  ts: string;
  ping_id: string;
}

export interface HealthPong {
  type: "HealthPong";
  session_id?: string;
  ts: string;
  ping_id: string;
  agent_health?: "ok" | "degraded";
  sandbox_state?: "ready" | "resetting" | "failed";
}

export type RelayEndpointFrame =
  | EndpointHello
  | EndpointHelloAck
  | CommandEnvelope
  | CommandAck
  | CommandResult
  | ProgressEventEndpointSide
  | ErrorEventEndpointToRelay
  | HealthPing
  | HealthPong;

// --- Endpoint ↔ Sandbox (vsock) frames ------------------------------------

export interface ToolDispatch {
  type: "ToolDispatch";
  command_id: string;
  tool: string;
  params: Record<string, unknown>;
  deadline_ms: number;
}

export interface ToolResult {
  type: "ToolResult";
  command_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  evidence_hash: string;
}

export interface EvidenceChunk {
  type: "EvidenceChunk";
  command_id: string;
  seq: number;
  chunk_data: string; // base64-encoded; HASH IS COMPUTED OVER DECODED BYTES (Q2)
  chunk_size: number; // length of decoded byte sequence
  is_terminal: boolean;
}

export interface GuestQuery {
  type: "GuestQuery";
  query_id: string; // UUIDv4; unique among inflight queries (V3-GQ-01)
  query_kind: "OpenFdCount" | "MemUsage" | "ProcessList";
  ts: string;
}

export type GuestResponseResult =
  | { open_fd_count: number }
  | { bytes_used: number; bytes_total: number }
  | { processes: Array<{ name: string; pid: number }> };

export interface GuestResponse {
  type: "GuestResponse";
  query_id: string;
  query_kind: "OpenFdCount" | "MemUsage" | "ProcessList";
  result: GuestResponseResult;
  ts: string;
}

export interface ResetSignal {
  type: "ResetSignal";
  reset_id: string;
  reason:
    | "post_dispatch"
    | "on_suspicion"
    | "on_idle"
    | "on_command_id_mismatch";
}

export interface ResetAck {
  type: "ResetAck";
  reset_id: string;
  reset_complete_at: string;
  golden_hash: string;
  verification_passed: boolean;
  verification_details: VerificationDetails;
}

export type EndpointSandboxFrame =
  | ToolDispatch
  | ToolResult
  | EvidenceChunk
  | GuestQuery
  | GuestResponse
  | ResetSignal
  | ResetAck;

// --- AuditLogEntry (anti-contamination via wrapper, F1) -------------------

export interface AuditLogEntry {
  id: number;
  command_id: string | null;
  ts: string;
  channel_of_origin: ChannelOfOrigin;
  message_type: string;
  payload_canonical_hash: string;
  payload_bytes_b64: string; // verbatim for operator origin
  metadata_sidecar: Record<string, unknown> | null;
  endpoint_id: string | null;
  session_id: string | null;
}
