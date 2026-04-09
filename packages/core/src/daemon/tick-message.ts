/**
 * Tick Message Formatter — builds the <tick> message injected each cycle.
 *
 * The tick message gives the model temporal context:
 * - Current time (for time-aware decisions)
 * - Tick number (for self-limiting behavior)
 * - Idle duration (how long since last activity)
 * - Log summary (what happened recently)
 * - Pending tasks (from scheduler)
 *
 * The model responds by either doing work or calling daemon_sleep.
 */

import type { DaemonState } from "./types.js";

export interface TickMessageContext {
  state: DaemonState;
  logSummary?: string;
  dueTasks?: string[];
  pendingTasks?: string[];
  budgetRemaining?: number;
  promptCacheStale?: boolean;
  /** Summary of active (system-tier) memory entries. */
  memorySummary?: string;
  /** Available skill names for autonomous invocation. */
  availableSkills?: Array<{ name: string; description: string }>;

  /** Fleet quality signals from quality observability middleware. */
  fleetSummary?: {
    activeSessions: number;
    avgReadEditRatio: number;
    totalFailures: number;
    degradedSessions: string[];
  };

  // ── Daemon Self-Awareness (KAIROS ↔ BR intelligence loop) ──

  /** Performance metrics from the router — makes the model aware of its own trajectory. */
  daemonMetrics?: DaemonMetrics;
}

export interface DaemonMetrics {
  /** Success rate over recent ticks (0.0-1.0). */
  successRate: number;
  /** Model momentum strength. */
  momentum: "strong" | "building" | "none" | "broken";
  /** Currently active model ID. */
  activeModel: string;
  /** Consecutive successes with current model. */
  consecutiveSuccesses: number;
  /** Budget pressure level. */
  budgetPressure: "healthy" | "moderate" | "high" | "critical";
  /** Whether tick interval has been stretched by cost pacer. */
  costPacingActive: boolean;
  /** Ticks until next approval gate (null = no gates configured). */
  ticksUntilGate: number | null;
  /** Convergence warning from Thompson sampling, if any. */
  convergenceWarning?: string;
}

export function formatTickMessage(ctx: TickMessageContext): string {
  const now = new Date();
  const idleSeconds = ctx.state.lastTickAt
    ? Math.floor((Date.now() - ctx.state.lastTickAt) / 1000)
    : 0;

  const parts: string[] = [
    `<tick time="${now.toISOString()}" tick_number="${ctx.state.tickCount + 1}" idle_seconds="${idleSeconds}">`,
  ];

  // Budget context
  if (ctx.budgetRemaining !== undefined) {
    parts.push(
      `  <budget remaining="$${ctx.budgetRemaining.toFixed(4)}" spent="$${ctx.state.totalCost.toFixed(4)}" />`,
    );
  }

  // Prompt cache status
  if (ctx.promptCacheStale) {
    parts.push(
      `  <cache status="stale" note="Prompt cache expired. This tick costs more input tokens." />`,
    );
  }

  // Scheduled tasks that are due
  if (ctx.dueTasks && ctx.dueTasks.length > 0) {
    parts.push(`  <due_tasks>`);
    for (const task of ctx.dueTasks) {
      parts.push(`    - ${task}`);
    }
    parts.push(`  </due_tasks>`);
  }

  // Pending tasks from user
  if (ctx.pendingTasks && ctx.pendingTasks.length > 0) {
    parts.push(`  <pending_tasks>`);
    for (const task of ctx.pendingTasks) {
      parts.push(`    - ${task}`);
    }
    parts.push(`  </pending_tasks>`);
  }

  // Recent activity summary
  if (ctx.logSummary) {
    parts.push(`  <recent_activity>`);
    parts.push(`    ${ctx.logSummary}`);
    parts.push(`  </recent_activity>`);
  }

  // Memory awareness — what the daemon knows
  if (ctx.memorySummary) {
    parts.push(`  <memory_summary>`);
    parts.push(`    ${ctx.memorySummary}`);
    parts.push(`  </memory_summary>`);
  }

  // Available skills — the daemon's playbook
  if (ctx.availableSkills && ctx.availableSkills.length > 0) {
    parts.push(`  <available_skills count="${ctx.availableSkills.length}">`);
    for (const skill of ctx.availableSkills) {
      parts.push(`    - ${skill.name}: ${skill.description}`);
    }
    parts.push(`  </available_skills>`);
  }

  // Fleet quality signals — aggregated from subagent quality observability
  if (ctx.fleetSummary) {
    const f = ctx.fleetSummary;
    parts.push(
      `  <fleet_quality sessions="${f.activeSessions}" avg_read_edit_ratio="${f.avgReadEditRatio}" failures="${f.totalFailures}">`,
    );
    if (f.degradedSessions.length > 0) {
      parts.push(
        `    <degraded count="${f.degradedSessions.length}" note="These sessions have Read:Edit ratio below 3.0 — agents are editing without sufficient research">`,
      );
      for (const sid of f.degradedSessions) {
        parts.push(`      - ${sid}`);
      }
      parts.push(`    </degraded>`);
    }
    parts.push(`  </fleet_quality>`);
  }

  // Daemon self-awareness — performance metrics from the router
  if (ctx.daemonMetrics) {
    const m = ctx.daemonMetrics;
    parts.push(`  <performance>`);
    parts.push(
      `    <model id="${m.activeModel}" momentum="${m.momentum}" successes="${m.consecutiveSuccesses}" />`,
    );
    parts.push(
      `    <success_rate>${(m.successRate * 100).toFixed(0)}%</success_rate>`,
    );
    parts.push(`    <budget_pressure>${m.budgetPressure}</budget_pressure>`);
    if (m.costPacingActive) {
      parts.push(
        `    <cost_pacing active="true" note="Tick intervals stretched to conserve budget" />`,
      );
    }
    if (m.ticksUntilGate !== null) {
      parts.push(`    <next_gate ticks="${m.ticksUntilGate}" />`);
    }
    if (m.convergenceWarning) {
      parts.push(`    <warning>${m.convergenceWarning}</warning>`);
    }
    parts.push(`  </performance>`);
  }

  parts.push(`</tick>`);
  parts.push("");
  parts.push(
    "You are in daemon mode. Review the tick context above. If there's work to do, do it. If not, call daemon_sleep with an appropriate duration and reason. Do not generate unnecessary output — be efficient with tokens.",
  );

  return parts.join("\n");
}
