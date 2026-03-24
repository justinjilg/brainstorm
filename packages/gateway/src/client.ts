import { createLogger } from '@brainstorm/shared';
import type {
  GatewaySelf, GatewayDiscovery, GatewayModel, ModelLeaderboardEntry,
  ApiKey, CreateKeyOptions, UsageSummary, DailyInsights, WasteInsights,
  BudgetForecast, GovernanceSummary, AuditEntry, MemoryEntry,
  GatewayAgentProfile,
} from './types.js';

const log = createLogger('gateway');

/**
 * BrainstormRouter gateway client.
 * Typed wrapper around the BR REST API for brainstorm-specific operations.
 */
export class BrainstormGateway {
  private baseUrl: string;
  private apiKey: string;
  private adminKey?: string;

  constructor(options: { apiKey: string; adminKey?: string; baseUrl?: string }) {
    this.apiKey = options.apiKey;
    this.adminKey = options.adminKey;
    this.baseUrl = options.baseUrl ?? 'https://api.brainstormrouter.com';
  }

  // ── Discovery ───────────────────────────────────────────────────────

  async getSelf(): Promise<GatewaySelf> {
    return this.get('/v1/self');
  }

  async getDiscovery(): Promise<GatewayDiscovery> {
    return this.get('/v1/discovery');
  }

  async getHealth(): Promise<{ status: string }> {
    return this.get('/health');
  }

  // ── Models ──────────────────────────────────────────────────────────

  async listModels(): Promise<GatewayModel[]> {
    const data = await this.get('/v1/models');
    return data.data ?? data.models ?? data;
  }

  async getRunnableModels(): Promise<GatewayModel[]> {
    const data = await this.get('/v1/catalog/runnable');
    return data.data ?? data.models ?? data;
  }

  async getLeaderboard(): Promise<ModelLeaderboardEntry[]> {
    const data = await this.get('/v1/models/leaderboard');
    return data.data ?? data.rankings ?? data;
  }

  async setAlias(alias: string, modelId: string): Promise<void> {
    await this.put(`/v1/config/aliases/${alias}`, { model: modelId });
  }

  // ── API Keys ────────────────────────────────────────────────────────

  async listKeys(): Promise<ApiKey[]> {
    const data = await this.get('/v1/api-keys', true);
    return Array.isArray(data) ? data : data.keys ?? data.data ?? [];
  }

  async createKey(opts: CreateKeyOptions): Promise<ApiKey & { key: string }> {
    return this.post('/v1/api-keys', {
      name: opts.name,
      prefix: 'br_live_',
      scopes: opts.scopes ?? ['developer'],
      allowed_models: opts.allowedModels,
      rate_limit_rpm: opts.rateLimitRpm ?? 100,
      budget_limit_usd: opts.budgetLimitUsd ?? 50,
      budget_period: opts.budgetPeriod ?? 'monthly',
    }, true);
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
    const params = period ? `?period=${period}` : '';
    return this.get(`/v1/usage/summary${params}`);
  }

  async getDailyInsights(): Promise<DailyInsights[]> {
    const data = await this.get('/v1/insights/daily');
    return data.data ?? data.insights ?? data;
  }

  async getWasteInsights(): Promise<WasteInsights> {
    return this.get('/v1/insights/waste');
  }

  async getForecast(): Promise<BudgetForecast> {
    return this.get('/v1/insights/forecast');
  }

  // ── Agents ──────────────────────────────────────────────────────────

  async listAgentProfiles(): Promise<GatewayAgentProfile[]> {
    const data = await this.get('/v1/agent/profiles');
    return data.data ?? data.profiles ?? data;
  }

  // ── Memory ──────────────────────────────────────────────────────────

  async storeMemory(block: string, content: string): Promise<void> {
    await this.post('/v1/memory/entries', { block, content });
  }

  async queryMemory(query: string): Promise<MemoryEntry[]> {
    const data = await this.post('/v1/memory/query', { query });
    return data.results ?? data.entries ?? data;
  }

  async listMemory(): Promise<MemoryEntry[]> {
    const data = await this.get('/v1/memory/entries');
    return data.data ?? data.entries ?? data;
  }

  // ── Governance ──────────────────────────────────────────────────────

  async getGovernanceSummary(): Promise<GovernanceSummary> {
    return this.get('/v1/governance/summary');
  }

  async getCompletionAudit(since?: string): Promise<AuditEntry[]> {
    const params = since ? `?since=${since}` : '';
    const data = await this.get(`/v1/governance/completion-audit${params}`);
    return data.data ?? data.entries ?? data;
  }

  // ── Capability Sync ─────────────────────────────────────────────────

  async pushCapabilityScores(modelId: string, scores: Record<string, number>): Promise<any> {
    return this.post(`/v1/models/${encodeURIComponent(modelId)}/capabilities`, {
      source: 'brainstorm-eval',
      version: '0.1.0',
      evaluated_at: new Date().toISOString(),
      scores,
    });
  }

  // ── Outcome Feedback ────────────────────────────────────────────────

  async reportOutcome(requestId: string, outcome: {
    success: boolean;
    codeCompiled?: boolean;
    testsPassed?: boolean;
    error?: string;
    taskType?: string;
    modelUsed?: string;
    cost?: number;
    toolCalls?: string[];
  }): Promise<any> {
    return this.post(`/v1/feedback/${requestId}`, {
      outcome: outcome.success ? 'success' : 'failure',
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
    return this.request('GET', path, undefined, useAdmin);
  }

  private async post(path: string, body: any, useAdmin = false): Promise<any> {
    return this.request('POST', path, body, useAdmin);
  }

  private async put(path: string, body: any, useAdmin = false): Promise<any> {
    return this.request('PUT', path, body, useAdmin);
  }

  private async request(method: string, path: string, body?: any, useAdmin = false): Promise<any> {
    const key = useAdmin && this.adminKey ? this.adminKey : this.apiKey;
    const url = `${this.baseUrl}${path}`;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${key}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const data = await response.json() as any;

      if (!response.ok) {
        const msg = data?.error?.message ?? `HTTP ${response.status}`;
        log.warn({ method, path, status: response.status, error: msg }, 'Gateway request failed');
        throw new Error(`Gateway ${method} ${path}: ${msg}`);
      }

      return data;
    } catch (error: any) {
      if (error.message?.startsWith('Gateway ')) throw error;
      log.warn({ method, path, err: error }, 'Gateway request error');
      throw new Error(`Gateway ${method} ${path}: ${error.message}`);
    }
  }
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
