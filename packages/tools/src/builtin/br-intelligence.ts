import { z } from 'zod';
import { defineTool } from '../base.js';

const BR_BASE = 'https://api.brainstormrouter.com';

/** Get the BR API key from env (set by the CLI from vault resolution). */
function getBRKey(): string | null {
  return process.env._BR_RESOLVED_KEY ?? process.env.BRAINSTORM_API_KEY ?? null;
}

async function brFetch(path: string): Promise<any> {
  const key = getBRKey();
  if (!key) return { error: 'No BrainstormRouter API key available.' };

  const res = await fetch(`${BR_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { error: `BR API ${res.status}: ${body.slice(0, 200)}` };
  }

  return res.json();
}

// ── Operations Dashboard ──────────────────────────────────────────

export const brStatusTool = defineTool({
  name: 'br_status',
  description: 'BrainstormRouter self-check: identity, budget remaining, provider health, recent errors, and suggestions. Call this to understand the current state of your AI gateway.',
  permission: 'auto',
  inputSchema: z.object({}),
  async execute() {
    return brFetch('/v1/self');
  },
});

// ── Budget ────────────────────────────────────────────────────────

export const brBudgetTool = defineTool({
  name: 'br_budget',
  description: 'Check your BrainstormRouter budget: daily/monthly spend, limits, remaining balance, and spend forecast. Call before expensive operations to avoid hitting limits.',
  permission: 'auto',
  inputSchema: z.object({}),
  async execute() {
    const [status, forecast] = await Promise.all([
      brFetch('/v1/budget/status'),
      brFetch('/v1/budget/forecast'),
    ]);
    return { status, forecast };
  },
});

// ── Model Rankings ────────────────────────────────────────────────

export const brLeaderboardTool = defineTool({
  name: 'br_leaderboard',
  description: 'Real model performance rankings from BrainstormRouter production data: quality, speed, reliability, cost efficiency. Use to understand which models are best for different tasks.',
  permission: 'auto',
  inputSchema: z.object({
    sort: z.enum(['overall', 'quality', 'speed', 'reliability', 'cost_efficiency']).optional()
      .describe('Sort by this dimension (default: overall)'),
  }),
  async execute({ sort }) {
    return brFetch(`/v1/intelligence/rankings${sort ? `?sort=${sort}` : ''}`);
  },
});

// ── Cost Insights ─────────────────────────────────────────────────

export const brInsightsTool = defineTool({
  name: 'br_insights',
  description: 'Cost optimization recommendations from BrainstormRouter: identifies waste, suggests cheaper models, estimates potential savings.',
  permission: 'auto',
  inputSchema: z.object({}),
  async execute() {
    return brFetch('/v1/insights/optimize');
  },
});

// ── Available Models ──────────────────────────────────────────────

export const brModelsTool = defineTool({
  name: 'br_models',
  description: 'List all models available through BrainstormRouter with pricing. Use to discover what models you can route to.',
  permission: 'auto',
  inputSchema: z.object({}),
  async execute() {
    return brFetch('/v1/models');
  },
});

// ── Memory ────────────────────────────────────────────────────────

export const brMemorySearchTool = defineTool({
  name: 'br_memory_search',
  description: 'Search BrainstormRouter persistent memory by keyword. Memory persists across sessions — use to recall previous context, decisions, or project state.',
  permission: 'auto',
  inputSchema: z.object({
    query: z.string().describe('Search query for memory entries'),
  }),
  async execute({ query }) {
    const key = getBRKey();
    if (!key) return { error: 'No BrainstormRouter API key available.' };

    const res = await fetch(`${BR_BASE}/v1/memory/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: `BR API ${res.status}: ${body.slice(0, 200)}` };
    }

    return res.json();
  },
});

export const brMemoryStoreTool = defineTool({
  name: 'br_memory_store',
  description: 'Save a fact to BrainstormRouter persistent memory. Persists across sessions. Use for important decisions, project context, or user preferences.',
  permission: 'confirm',
  inputSchema: z.object({
    text: z.string().describe('The fact or context to remember'),
    block: z.enum(['semantic', 'episodic', 'procedural']).optional()
      .describe('Memory type: semantic (knowledge), episodic (events), procedural (how-to)'),
  }),
  async execute({ text, block }) {
    const key = getBRKey();
    if (!key) return { error: 'No BrainstormRouter API key available.' };

    const res = await fetch(`${BR_BASE}/v1/memory/store`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ context: text, block: block ?? 'semantic' }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: `BR API ${res.status}: ${body.slice(0, 200)}` };
    }

    return res.json();
  },
});

// ── Health Check ──────────────────────────────────────────────────

export const brHealthTool = defineTool({
  name: 'br_health',
  description: 'Quick health check of BrainstormRouter. Returns version, uptime, and endpoint counts. Use as a connectivity test when things seem slow or broken.',
  permission: 'auto',
  inputSchema: z.object({}),
  async execute() {
    return brFetch('/v1/health');
  },
});
