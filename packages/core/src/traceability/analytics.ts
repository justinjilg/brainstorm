/**
 * Engineering Analytics — aggregates trajectory, routing, and cost data
 * into productivity metrics.
 *
 * Inspired by CyberFabric's Insight platform. Uses data Brainstorm
 * already collects (trajectories, routing outcomes, cost records, tool
 * health) to produce actionable metrics.
 */

import type Database from "better-sqlite3";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("analytics");

export interface AnalyticsReport {
  period: { from: string; to: string };
  sessions: SessionMetrics;
  models: ModelMetrics[];
  tools: ToolMetrics[];
  costs: CostMetrics;
  sectors?: SectorMetrics[];
}

export interface SessionMetrics {
  totalSessions: number;
  totalTurns: number;
  avgTurnsPerSession: number;
  avgDurationMinutes: number;
}

export interface ModelMetrics {
  modelId: string;
  provider: string;
  tasksRouted: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  totalCost: number;
  successRate: number;
}

export interface ToolMetrics {
  toolName: string;
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  blockedCount: number;
}

export interface CostMetrics {
  totalCost: number;
  costByProvider: Record<string, number>;
  costByTaskType: Record<string, number>;
  dailyAverage: number;
}

export interface SectorMetrics {
  sectorName: string;
  tier: string;
  tickCount: number;
  totalCost: number;
  objectivesCompleted: number;
  objectivesTotal: number;
}

/**
 * Generate an analytics report from the project database.
 *
 * Queries cost_records, sessions, and routing data that Brainstorm
 * already persists during normal operation.
 */
export function generateAnalyticsReport(
  db: Database.Database,
  opts?: { daysBack?: number },
): AnalyticsReport {
  const daysBack = opts?.daysBack ?? 30;
  const cutoff = Math.floor(Date.now() / 1000) - daysBack * 86400;
  const now = new Date().toISOString();
  const from = new Date(cutoff * 1000).toISOString();

  // ── Session metrics ─────────────────────────────────────────────
  let sessions: SessionMetrics = {
    totalSessions: 0,
    totalTurns: 0,
    avgTurnsPerSession: 0,
    avgDurationMinutes: 0,
  };
  try {
    const sessionRows = db
      .prepare(
        `
      SELECT COUNT(*) AS total,
             SUM(turn_count) AS turns,
             AVG(duration_seconds) AS avgDuration
      FROM sessions
      WHERE started_at > ?
    `,
      )
      .get(cutoff) as any;
    if (sessionRows?.total) {
      sessions = {
        totalSessions: sessionRows.total,
        totalTurns: sessionRows.turns ?? 0,
        avgTurnsPerSession: sessionRows.turns
          ? sessionRows.turns / sessionRows.total
          : 0,
        avgDurationMinutes: (sessionRows.avgDuration ?? 0) / 60,
      };
    }
  } catch {
    /* table may not exist */
  }

  // ── Model metrics ───────────────────────────────────────────────
  const models: ModelMetrics[] = [];
  try {
    const modelRows = db
      .prepare(
        `
      SELECT model_id, provider,
             COUNT(*) AS tasks,
             AVG(input_tokens) AS avgIn,
             AVG(output_tokens) AS avgOut,
             SUM(cost) AS totalCost
      FROM cost_records
      WHERE timestamp > ?
      GROUP BY model_id, provider
      ORDER BY totalCost DESC
    `,
      )
      .all(cutoff) as any[];

    // Load success rates from model_performance_v2 (routing outcome data)
    const successRates = new Map<string, number>();
    try {
      const perfRows = db
        .prepare(
          `
        SELECT model_id,
               CAST(SUM(success) AS REAL) / COUNT(*) AS rate
        FROM model_performance_v2
        WHERE timestamp > ?
        GROUP BY model_id
      `,
        )
        .all(cutoff) as Array<{ model_id: string; rate: number }>;
      for (const row of perfRows) {
        successRates.set(row.model_id, row.rate);
      }
    } catch {
      /* table may not exist */
    }

    for (const row of modelRows) {
      models.push({
        modelId: row.model_id,
        provider: row.provider,
        tasksRouted: row.tasks,
        avgInputTokens: Math.round(row.avgIn ?? 0),
        avgOutputTokens: Math.round(row.avgOut ?? 0),
        totalCost: row.totalCost ?? 0,
        successRate: successRates.get(row.model_id) ?? 1.0,
      });
    }
  } catch {
    /* table may not exist */
  }

  // ── Cost metrics ────────────────────────────────────────────────
  let totalCost = 0;
  const costByProvider: Record<string, number> = {};
  const costByTaskType: Record<string, number> = {};
  try {
    const costRows = db
      .prepare(
        `
      SELECT provider, task_type, SUM(cost) AS cost
      FROM cost_records
      WHERE timestamp > ?
      GROUP BY provider, task_type
    `,
      )
      .all(cutoff) as any[];

    for (const row of costRows) {
      totalCost += row.cost;
      costByProvider[row.provider] =
        (costByProvider[row.provider] ?? 0) + row.cost;
      if (row.task_type) {
        costByTaskType[row.task_type] =
          (costByTaskType[row.task_type] ?? 0) + row.cost;
      }
    }
  } catch {
    /* table may not exist */
  }

  const costs: CostMetrics = {
    totalCost,
    costByProvider,
    costByTaskType,
    dailyAverage: daysBack > 0 ? totalCost / daysBack : 0,
  };

  // ── Tool metrics ────────────────────────────────────────────────
  const tools: ToolMetrics[] = [];
  // Tool metrics come from trajectory data — check if available
  try {
    const toolRows = db
      .prepare(
        `
      SELECT tool_name, COUNT(*) AS calls,
             AVG(duration_ms) AS avgDuration,
             SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes,
             SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked
      FROM tool_calls
      WHERE timestamp > ?
      GROUP BY tool_name
      ORDER BY calls DESC
      LIMIT 30
    `,
      )
      .all(cutoff) as any[];

    for (const row of toolRows) {
      tools.push({
        toolName: row.tool_name,
        totalCalls: row.calls,
        successRate: row.calls > 0 ? row.successes / row.calls : 0,
        avgDurationMs: Math.round(row.avgDuration ?? 0),
        blockedCount: row.blocked ?? 0,
      });
    }
  } catch {
    /* table may not exist */
  }

  return {
    period: { from, to: now },
    sessions,
    models,
    tools,
    costs,
  };
}

/**
 * Format analytics report as markdown.
 */
export function formatAnalyticsMarkdown(report: AnalyticsReport): string {
  const lines = [
    "# Engineering Analytics Report",
    "",
    `**Period:** ${report.period.from.slice(0, 10)} to ${report.period.to.slice(0, 10)}`,
    "",
    "## Sessions",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Sessions | ${report.sessions.totalSessions} |`,
    `| Total Turns | ${report.sessions.totalTurns} |`,
    `| Avg Turns/Session | ${report.sessions.avgTurnsPerSession.toFixed(1)} |`,
    `| Avg Duration | ${report.sessions.avgDurationMinutes.toFixed(0)} min |`,
    "",
  ];

  if (report.models.length > 0) {
    lines.push(
      "## Model Effectiveness",
      "",
      "| Model | Provider | Tasks | Avg In/Out Tokens | Cost |",
      "|-------|----------|-------|-------------------|------|",
      ...report.models.map(
        (m) =>
          `| ${m.modelId} | ${m.provider} | ${m.tasksRouted} | ${m.avgInputTokens}/${m.avgOutputTokens} | $${m.totalCost.toFixed(4)} |`,
      ),
      "",
    );
  }

  lines.push(
    "## Cost Summary",
    "",
    `**Total:** $${report.costs.totalCost.toFixed(4)}`,
    `**Daily Average:** $${report.costs.dailyAverage.toFixed(4)}`,
    "",
  );

  if (Object.keys(report.costs.costByProvider).length > 0) {
    lines.push(
      "**By Provider:**",
      ...Object.entries(report.costs.costByProvider).map(
        ([p, c]) => `- ${p}: $${c.toFixed(4)}`,
      ),
      "",
    );
  }

  if (report.tools.length > 0) {
    lines.push(
      "## Tool Usage",
      "",
      "| Tool | Calls | Success Rate | Avg Duration | Blocked |",
      "|------|-------|-------------|-------------|---------|",
      ...report.tools
        .slice(0, 15)
        .map(
          (t) =>
            `| ${t.toolName} | ${t.totalCalls} | ${(t.successRate * 100).toFixed(0)}% | ${t.avgDurationMs}ms | ${t.blockedCount} |`,
        ),
      "",
    );
  }

  return lines.join("\n");
}
