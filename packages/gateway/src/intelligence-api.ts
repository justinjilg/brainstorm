/**
 * BR Agent Intelligence API — the moat Portkey can't copy.
 *
 * Exposes Brainstorm's agent intelligence through BrainstormRouter's API
 * so any client (not just the CLI) can use it.
 *
 * Portkey routes tokens. We route tasks. Our intelligence comes from
 * understanding what the agent is DOING (writing code, debugging, testing)
 * and which models perform best for each activity. This requires the
 * full agent context, not just API traffic.
 *
 * Endpoints:
 *   POST /v1/agent/trajectory       — Submit trajectory for analysis
 *   GET  /v1/agent/recommendations  — Get routing recommendations
 *   POST /v1/agent/ensemble/rank    — Rank models for ensemble
 *   GET  /v1/intelligence/cost-forecast — Predict task cost
 *   POST /v1/community/patterns     — Submit tool usage patterns
 *   GET  /v1/community/patterns     — Get community tool preferences
 */

import { createLogger } from '@brainstorm/shared';

const log = createLogger('intelligence-api');

export interface TrajectorySubmission {
  sessionId: string;
  projectFramework: string;
  events: Array<{
    type: string;
    model?: string;
    toolName?: string;
    ok?: boolean;
    cost?: number;
    latencyMs?: number;
    taskType?: string;
    complexity?: string;
  }>;
  totalCost: number;
  totalTurns: number;
  success: boolean;
}

export interface RoutingRecommendation {
  taskType: string;
  recommendedModel: string;
  confidence: number;
  reasoning: string;
  alternatives: Array<{ model: string; score: number }>;
}

export interface EnsembleRanking {
  models: Array<{ model: string; score: number; reasoning: string }>;
  recommendedCount: number;
}

export interface CostForecast {
  taskType: string;
  complexity: string;
  estimatedCost: number;
  range: [number, number];
  basedOnSamples: number;
}

export interface CommunityPattern {
  framework: string;
  taskType: string;
  preferredTools: string[];
  avoidTools: string[];
  confirmations: number;
}

/**
 * Client for BrainstormRouter's Agent Intelligence API.
 * Uses unified request() method consistent with BrainstormGateway client.
 */
export class IntelligenceAPIClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  /** Submit a session trajectory for analysis and learning. */
  async submitTrajectory(submission: TrajectorySubmission): Promise<boolean> {
    try {
      await this.request('POST', '/v1/agent/trajectory', submission);
      return true;
    } catch (e) {
      log.warn({ err: e }, 'Failed to submit trajectory');
      return false;
    }
  }

  /** Get routing recommendations based on project patterns. */
  async getRecommendations(
    taskType: string,
    framework: string,
  ): Promise<RoutingRecommendation[]> {
    return this.request('GET', `/v1/agent/recommendations?taskType=${encodeURIComponent(taskType)}&framework=${encodeURIComponent(framework)}`);
  }

  /** Rank candidate models for ensemble generation. */
  async rankForEnsemble(
    taskType: string,
    complexity: string,
    candidateModels: string[],
  ): Promise<EnsembleRanking> {
    return this.request('POST', '/v1/agent/ensemble/rank', {
      taskType,
      complexity,
      candidateModels,
    });
  }

  /** Predict cost for a task before executing. */
  async forecastCost(
    taskType: string,
    complexity: string,
    framework: string,
  ): Promise<CostForecast> {
    return this.request('GET',
      `/v1/intelligence/cost-forecast?taskType=${encodeURIComponent(taskType)}&complexity=${encodeURIComponent(complexity)}&framework=${encodeURIComponent(framework)}`,
    );
  }

  /** Submit anonymized tool usage patterns. */
  async submitPattern(pattern: CommunityPattern): Promise<boolean> {
    try {
      await this.request('POST', '/v1/community/patterns', pattern);
      return true;
    } catch (e) {
      log.warn({ err: e }, 'Failed to submit community pattern');
      return false;
    }
  }

  /** Get community tool preferences for a framework. */
  async getPatterns(framework: string): Promise<CommunityPattern[]> {
    return this.request('GET', `/v1/community/patterns?framework=${encodeURIComponent(framework)}`);
  }

  /** Unified request method — consistent with BrainstormGateway client pattern. */
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.baseUrl}${path}`;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });

      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        const preview = text.slice(0, 200).replace(/\n/g, ' ');
        const msg = `HTTP ${response.status}: non-JSON response (${preview})`;
        log.warn({ method, path, status: response.status }, msg);
        throw new Error(`Intelligence API ${method} ${path}: ${msg}`);
      }

      if (!response.ok) {
        const msg = data?.error?.message ?? `HTTP ${response.status}`;
        log.warn({ method, path, status: response.status, error: msg }, 'Intelligence API request failed');
        throw new Error(`Intelligence API ${method} ${path}: ${msg}`);
      }

      return data;
    } catch (error: any) {
      if (error.message?.startsWith('Intelligence API ')) throw error;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new Error(`Intelligence API ${method} ${path}: request timed out after 15s`);
      }
      log.warn({ method, path, errorMessage: error.message }, 'Intelligence API request error');
      throw new Error(`Intelligence API ${method} ${path}: ${error.message}`);
    }
  }
}

/**
 * Create an Intelligence API client from environment.
 * Uses same env vars as BrainstormGateway for consistency.
 */
export function createIntelligenceClient(): IntelligenceAPIClient | null {
  const baseUrl = process.env.BRAINSTORM_GATEWAY_URL ?? 'https://api.brainstormrouter.com';
  const apiKey = process.env.BRAINSTORM_API_KEY;

  if (!apiKey) return null;

  return new IntelligenceAPIClient(baseUrl, apiKey);
}
