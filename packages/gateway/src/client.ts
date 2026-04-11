import { randomBytes } from "node:crypto";
import { gatewayRequest } from "./http.js";

import type {
  GatewaySelf,
  GatewayDiscovery,
  GatewayModel,
  ModelLeaderboardEntry,
  ApiKey,
  CreateKeyOptions,
  UsageSummary,
  DailyInsights,
  WasteInsights,
  BudgetForecast,
  GovernanceSummary,
  AuditEntry,
  MemoryEntry,
  GatewayAgentProfile,
} from "./types.js";

/**
 * BrainstormRouter gateway client.
 * Typed wrapper around the BR REST API for brainstorm-specific operations.
 */
export class BrainstormGateway {
  private baseUrl: string;
  private apiKey: string;
  private adminKey?: string;
  private csrfToken: string;

  constructor(options: {
    apiKey: string;
    adminKey?: string;
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    this.adminKey = options.adminKey;
    this.baseUrl = options.baseUrl ?? "https://api.brainstormrouter.com";
    this.csrfToken = randomBytes(16).toString("hex");
  }

  // ── Discovery ───────────────────────────────────────────────────────

  async getSelf(): Promise<GatewaySelf> {
    return this.get("/v1/self");
  }

  async getDiscovery(): Promise<GatewayDiscovery> {
    return this.get("/v1/discovery");
  }

  async getHealth(): Promise<{ status: string }> {
    return this.get("/health");
  }

  // ── Models ──────────────────────────────────────────────────────────

  async listModels(): Promise<GatewayModel[]> {
    const data = await this.get("/v1/models");
    return unwrapArray(data, "data", "models");
  }

  async getRunnableModels(): Promise<GatewayModel[]> {
    const data = await this.get("/v1/catalog/runnable");
    return unwrapArray(data, "data", "models");
  }

  async getLeaderboard(): Promise<ModelLeaderboardEntry[]> {
    const data = await this.get("/v1/models/leaderboard");
    return unwrapArray(data, "data", "rankings");
  }

  async setAlias(alias: string, modelId: string): Promise<void> {
    await this.put(`/v1/config/aliases/${alias}`, { model: modelId });
  }

  // ── API Keys ────────────────────────────────────────────────────────

  async listKeys(): Promise<ApiKey[]> {
    const data = await this.get("/v1/api-keys", true);
    return unwrapArray(data, "keys", "data");
  }

  async createKey(opts: CreateKeyOptions): Promise<ApiKey & { key: string }> {
    return this.post(
      "/v1/api-keys",
      {
        name: opts.name,
        prefix: "br_live_",
        scopes: opts.scopes ?? ["developer"],
        allowed_models: opts.allowedModels,
        rate_limit_rpm: opts.rateLimitRpm ?? 100,
        budget_limit_usd: opts.budgetLimitUsd ?? 50,
        budget_period: opts.budgetPeriod ?? "monthly",
      },
      true,
    );
  }

  // ── Config ──────────────────────────────────────────────────────────

  async getConfig(key: string): Promise<any> {
    const data = await this.get(`/v1/config/${key}`, true);
    return data.data ?? data;
  }

  async setConfig(key: string, value: any): Promise<void> {
    await this.put(`/v1/config/${key}`, value, true);
  }

  // ── Usage & Insights ────────────────────────────────────────────────

  async getUsageSummary(period?: string): Promise<UsageSummary> {
    const params = period ? `?period=${period}` : "";
    return this.get(`/v1/usage/summary${params}`);
  }

  async getDailyInsights(): Promise<DailyInsights[]> {
    const data = await this.get("/v1/insights/daily");
    return unwrapArray(data, "data", "insights");
  }

  async getWasteInsights(): Promise<WasteInsights> {
    return this.get("/v1/insights/waste");
  }

  async getForecast(): Promise<BudgetForecast> {
    return this.get("/v1/insights/forecast");
  }

  // ── Agents ──────────────────────────────────────────────────────────

  async listAgentProfiles(): Promise<GatewayAgentProfile[]> {
    const data = await this.get("/v1/agent/profiles");
    return unwrapArray(data, "data", "profiles");
  }

  // ── Memory ──────────────────────────────────────────────────────────
  //
  // Core memory CRUD. All methods now accept an optional `project`
  // parameter so entries are scoped to a project slug. Without scope,
  // memory pollutes across projects (the spec-design concern from
  // docs/br-capability-audit.md).

  async storeMemory(
    block: string,
    content: string,
    project?: string,
  ): Promise<void> {
    await this.post("/v1/memory/entries", {
      block,
      content,
      ...(project ? { project } : {}),
    });
  }

  async queryMemory(query: string, project?: string): Promise<MemoryEntry[]> {
    const data = await this.post("/v1/memory/query", {
      query,
      ...(project ? { project } : {}),
    });
    return unwrapArray(data, "results", "entries");
  }

  async listMemory(project?: string): Promise<MemoryEntry[]> {
    const path = project
      ? `/v1/memory/entries?project=${encodeURIComponent(project)}`
      : "/v1/memory/entries";
    const data = await this.get(path);
    return unwrapArray(data, "data", "entries");
  }

  /**
   * Initialize memory from source documents. BR's agent reads the docs
   * and extracts structured facts into memory blocks. This is the
   * server-side equivalent of Letta Code's /init command — already
   * shipped on BR, not yet exposed via brainstorm CLI.
   *
   * Use case: `brainstorm memory init --from <claude-code-session.jsonl>`
   * — ingest prior Claude Code sessions so a new user's brainstorm
   * agent starts with their existing context.
   */
  async initMemoryFromDocs(
    documents: Array<{ content: string; source?: string }>,
    model?: string,
  ): Promise<{
    status: string;
    summary: string;
    entries_after: number;
    entries: Array<unknown>;
  }> {
    return this.post("/v1/memory/init", {
      documents,
      ...(model ? { model } : {}),
    });
  }

  // ── Shared / Team Memory ──────────────────────────────────────────
  //
  // Shared memory is the team primitive — entries visible to every
  // user in the tenant, gated by an optional approval workflow.
  // See /v1/memory/shared/* and /v1/memory/pending/* in BR.

  async storeSharedMemory(
    fact: string,
    block: string = "general",
  ): Promise<{ ok: boolean; status?: string; approvalId?: string }> {
    return this.post("/v1/memory/shared/store", { fact, block });
  }

  async listSharedMemory(): Promise<{
    entries: Array<{
      id: string;
      fact: string;
      block: string;
      createdAt: string;
      createdBy: string;
    }>;
    total: number;
    pendingApprovals: number;
  }> {
    return this.get("/v1/memory/shared/entries");
  }

  async getApprovalConfig(): Promise<{ requireApproval: boolean }> {
    return this.get("/v1/memory/approval-config");
  }

  async setApprovalConfig(requireApproval: boolean): Promise<void> {
    await this.put("/v1/memory/approval-config", { requireApproval });
  }

  async listPendingMemory(): Promise<
    Array<{
      id: string;
      type: string;
      status: string;
      summary: string;
      details: Record<string, unknown>;
      createdAt: string;
      expiresAt: string;
    }>
  > {
    const data = await this.get("/v1/memory/pending");
    return unwrapArray(data, "data", "pending");
  }

  async approvePendingMemory(approvalId: string): Promise<void> {
    await this.post(`/v1/memory/pending/${approvalId}/approve`, {});
  }

  async rejectPendingMemory(
    approvalId: string,
    reason?: string,
  ): Promise<void> {
    await this.post(`/v1/memory/pending/${approvalId}/reject`, {
      ...(reason ? { reason } : {}),
    });
  }

  // ── Governance ──────────────────────────────────────────────────────

  async getGovernanceSummary(): Promise<GovernanceSummary> {
    return this.get("/v1/governance/summary");
  }

  async getCompletionAudit(since?: string): Promise<AuditEntry[]> {
    const params = since ? `?since=${since}` : "";
    const data = await this.get(`/v1/governance/completion-audit${params}`);
    return unwrapArray(data, "data", "entries");
  }

  // ── Capability Sync ─────────────────────────────────────────────────

  async pushCapabilityScores(
    modelId: string,
    scores: Record<string, number>,
  ): Promise<any> {
    return this.post(`/v1/models/${encodeURIComponent(modelId)}/capabilities`, {
      source: "brainstorm-eval",
      version: "0.1.0",
      evaluated_at: new Date().toISOString(),
      scores,
    });
  }

  // ── Outcome Feedback ────────────────────────────────────────────────

  async reportOutcome(
    requestId: string,
    outcome: {
      success: boolean;
      codeCompiled?: boolean;
      testsPassed?: boolean;
      error?: string;
      taskType?: string;
      modelUsed?: string;
      cost?: number;
      toolCalls?: string[];
    },
  ): Promise<any> {
    return this.post(`/v1/feedback/${requestId}`, {
      outcome: outcome.success ? "success" : "failure",
      signals: {
        code_compiled: outcome.codeCompiled,
        tests_passed: outcome.testsPassed,
      },
      error: outcome.error,
      task_profile: outcome.taskType ? { type: outcome.taskType } : undefined,
      model_used: outcome.modelUsed,
      cost_actual: outcome.cost,
      tool_calls: outcome.toolCalls,
    });
  }

  // ── HTTP Helpers ────────────────────────────────────────────────────

  private async get(path: string, useAdmin = false): Promise<any> {
    return this.request("GET", path, undefined, useAdmin);
  }

  private async post(path: string, body: any, useAdmin = false): Promise<any> {
    return this.request("POST", path, body, useAdmin);
  }

  private async put(path: string, body: any, useAdmin = false): Promise<any> {
    return this.request("PUT", path, body, useAdmin);
  }

  private async request(
    method: string,
    path: string,
    body?: any,
    useAdmin = false,
  ): Promise<any> {
    const key = useAdmin && this.adminKey ? this.adminKey : this.apiKey;
    return gatewayRequest(this.baseUrl, key, method, path, body, "Gateway", {
      "X-CSRF-Token": this.csrfToken,
    });
  }

  /**
   * Raw request exposed for the sync worker. The worker replays queued
   * requests verbatim (method, path, body) and needs to send an
   * idempotency key header so BR can deduplicate retries server-side.
   *
   * Throws on non-2xx so the worker can catch and mark the queue row
   * failed. Returns the parsed response body on success.
   */
  async requestRaw(
    method: string,
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    return gatewayRequest(
      this.baseUrl,
      this.apiKey,
      method,
      path,
      body,
      "Gateway",
      {
        "X-CSRF-Token": this.csrfToken,
        "X-Idempotency-Key": idempotencyKey,
      },
    );
  }
}

/**
 * Safely unwrap an API response array from various envelope shapes.
 * Throws if the result is not an array (catches API errors masquerading as data).
 */
function unwrapArray(data: any, ...keys: string[]): any[] {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data)) return data;
  return [];
}

/**
 * Create a gateway client from environment variables.
 */
export function createGatewayClient(): BrainstormGateway | null {
  const apiKey = process.env.BRAINSTORM_API_KEY;
  if (!apiKey) return null;

  return new BrainstormGateway({
    apiKey,
    adminKey: process.env.BRAINSTORM_ADMIN_KEY,
    baseUrl: process.env.BRAINSTORM_GATEWAY_URL,
  });
}
