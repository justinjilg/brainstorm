// ── Gateway Identity ─────────────────────────────────────────────────

export interface GatewaySelf {
  identity: {
    tenant_id: string;
    auth_method: string;
    key_id: string;
    agent_id: string | null;
    roles: string[];
    scopes: string[];
  };
  capabilities: {
    granted: string[];
  };
}

// ── Models ───────────────────────────────────────────────────────────

export interface GatewayModel {
  id: string;
  name: string;
  provider: string;
  pricing?: { input: number; output: number };
  context_window?: number;
  capabilities?: string[];
}

export interface ModelLeaderboardEntry {
  model: string;
  provider: string;
  quality_rank: number;
  speed_rank: number;
  value_rank: number;
  request_count: number;
  avg_latency_ms: number;
}

// ── API Keys ─────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  allowedModels: string[] | null;
  rateLimitRpm: number;
  budgetLimitUsd: number;
  budgetPeriod: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateKeyOptions {
  name: string;
  scopes?: string[];
  allowedModels?: string[];
  rateLimitRpm?: number;
  budgetLimitUsd?: number;
  budgetPeriod?: string;
}

// ── Usage & Insights ─────────────────────────────────────────────────

export interface UsageSummary {
  period: string;
  total_requests: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  by_model: Array<{ model: string; requests: number; cost_usd: number }>;
}

export interface DailyInsights {
  date: string;
  cost_usd: number;
  request_count: number;
  avg_latency_ms: number;
  top_models: Array<{ model: string; cost_usd: number }>;
}

export interface WasteInsights {
  total_waste_usd: number;
  suggestions: Array<{ description: string; savings_usd: number; action: string }>;
}

export interface BudgetForecast {
  current_spend_usd: number;
  budget_limit_usd: number;
  projected_end_of_period_usd: number;
  will_exceed: boolean;
  days_remaining: number;
}

// ── Governance ───────────────────────────────────────────────────────

export interface GovernanceSummary {
  memory_health: { total_entries: number; compliance_status: string };
  audit_stats: { total_requests: number; flagged: number };
  anomaly_score: number;
}

export interface AuditEntry {
  request_id: string;
  timestamp: string;
  model: string;
  cost_usd: number;
  latency_ms: number;
  guardian_status: string;
}

// ── Memory ───────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  block: string;
  content: string;
  created_at: string;
}

// ── Agent Profiles ───────────────────────────────────────────────────

export interface GatewayAgentProfile {
  id: string;
  name: string;
  role: string;
  model: string;
  status: string;
  budget_remaining: number;
}

// ── Response Headers ─────────────────────────────────────────────────

export interface GatewayFeedback {
  budgetRemaining?: number;
  guardianStatus?: string;
  routingDecision?: string;
  actualCost?: number;
  cacheHit?: boolean;
  complexityScore?: number;
  selectedModel?: string;
  requestId?: string;
}

// ── Discovery ────────────────────────────────────────────────────────

export interface GatewayDiscovery {
  health: string;
  budget: { remaining_usd: number; limit_usd: number; period: string };
  models: { available: number; runnable: number };
  capabilities: string[];
}
