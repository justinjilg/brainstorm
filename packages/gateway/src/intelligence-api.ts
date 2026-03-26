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
    return this.post('/v1/agent/trajectory', submission);
  }

  /** Get routing recommendations based on project patterns. */
  async getRecommendations(
    taskType: string,
    framework: string,
  ): Promise<RoutingRecommendation[]> {
    return this.get(`/v1/agent/recommendations?taskType=${encodeURIComponent(taskType)}&framework=${encodeURIComponent(framework)}`);
  }

  /** Rank candidate models for ensemble generation. */
  async rankForEnsemble(
    taskType: string,
    complexity: string,
    candidateModels: string[],
  ): Promise<EnsembleRanking> {
    return this.postJson('/v1/agent/ensemble/rank', {
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
    return this.get(
      `/v1/intelligence/cost-forecast?taskType=${encodeURIComponent(taskType)}&complexity=${encodeURIComponent(complexity)}&framework=${encodeURIComponent(framework)}`,
    );
  }

  /** Submit anonymized tool usage patterns. */
  async submitPattern(pattern: CommunityPattern): Promise<boolean> {
    return this.post('/v1/community/patterns', pattern);
  }

  /** Get community tool preferences for a framework. */
  async getPatterns(framework: string): Promise<CommunityPattern[]> {
    return this.get(`/v1/community/patterns?framework=${encodeURIComponent(framework)}`);
  }

  private async post(path: string, body: unknown): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Intelligence API error: ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Intelligence API error: ${response.status}`);
    }

    return (await response.json()) as T;
  }
}

/**
 * Create an Intelligence API client from environment.
 */
export function createIntelligenceClient(): IntelligenceAPIClient | null {
  const baseUrl = process.env.BRAINSTORM_ROUTER_URL ?? 'https://api.brainstormrouter.com';
  const apiKey = process.env.BRAINSTORM_API_KEY;

  if (!apiKey) return null;

  return new IntelligenceAPIClient(baseUrl, apiKey);
}
