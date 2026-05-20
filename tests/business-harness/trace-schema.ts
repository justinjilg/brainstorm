export interface BusinessHarnessTrace {
  run_id: string;
  started_at: string;
  completed_at?: string;
  tenant: {
    id_hash: string;
    slug?: string;
  };
  actor: {
    kind: "operator" | "agent" | "ci";
    subject_hash: string;
    auth_mode:
      | "api_key"
      | "keycloak"
      | "service_jwt"
      | "community_key"
      | "unknown";
  };
  intent: {
    text_redacted: string;
    category:
      | "status"
      | "investigate"
      | "simulate_write"
      | "execute_write"
      | "backup"
      | "security";
  };
  br: {
    base_url: string;
    request_ids: string[];
    routed_models: string[];
    total_cost_usd?: number;
    audit_hashes: string[];
    envelope_modes: string[];
    unknown_headers: string[];
  };
  registry: {
    source: "br" | "vm" | "mixed";
    capabilities_seen: number;
    products_seen: string[];
    stale_or_ambiguous: string[];
  };
  actions: Array<{
    step: string;
    system:
      | "brainstorm"
      | "br"
      | "msp"
      | "vm"
      | "backup"
      | "gtm"
      | "security"
      | "endpoint_stub";
    mode: "read_only" | "simulate" | "execute";
    capability?: string;
    target_did_hash?: string;
    traceparent?: string;
    request_id_hash?: string;
    idempotency_key_hash?: string;
    evidence_hash?: string;
    changeset_id?: string;
    status: "ok" | "blocked" | "degraded" | "failed";
    error_code?: string;
  }>;
  result: {
    success: boolean;
    safety_outcome:
      | "no_writes"
      | "simulated_only"
      | "approved_write"
      | "blocked";
    notes: string[];
  };
}

export interface LiveDiscoveryProbeSummary {
  id: string;
  method: string;
  url: string;
  auth: "none" | "bearer";
  status: number;
  ok: boolean;
  body_kind: "array" | "empty" | "object" | "text";
  observations: string[];
  request_id_hash?: string;
  routed_model?: string;
  audit_hash?: string;
  envelope_mode?: string;
  unknown_headers: string[];
}

export interface LiveDiscoverySummary {
  schema_version: 1;
  generated_at: string;
  success: boolean;
  probes: LiveDiscoveryProbeSummary[];
  failures: string[];
  warnings: string[];
  trace: BusinessHarnessTrace;
}
