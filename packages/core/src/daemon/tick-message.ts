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

  parts.push(`</tick>`);
  parts.push("");
  parts.push(
    "You are in daemon mode. Review the tick context above. If there's work to do, do it. If not, call daemon_sleep with an appropriate duration and reason. Do not generate unnecessary output — be efficient with tokens.",
  );

  return parts.join("\n");
}
