/**
 * Fleet Signals Middleware — aggregates quality metrics across subagents.
 *
 * When KAIROS runs multiple subagents, each session tracks its own Read:Edit
 * ratio, tool failure rate, and cost. This middleware aggregates those into
 * a fleet-level dashboard that the daemon tick message can include.
 *
 * The daemon can then make decisions based on fleet health: throttle degraded
 * subagents, switch models, or pause for human review.
 */

import type { AgentMiddleware, MiddlewareToolResult } from "../types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("fleet-signals");

export interface SubagentSignals {
  sessionId: string;
  readCount: number;
  writeCount: number;
  toolFailures: number;
  toolSuccesses: number;
  totalCost: number;
  stopViolations: number;
  lastActivity: number;
}

// Shared fleet state — singleton across the process
const fleetState = new Map<string, SubagentSignals>();

export function createFleetSignalsMiddleware(
  sessionId?: string,
): AgentMiddleware {
  const sid = sessionId ?? `session-${Date.now()}`;

  // Initialize this session's signals
  if (!fleetState.has(sid)) {
    fleetState.set(sid, {
      sessionId: sid,
      readCount: 0,
      writeCount: 0,
      toolFailures: 0,
      toolSuccesses: 0,
      totalCost: 0,
      stopViolations: 0,
      lastActivity: Date.now(),
    });
  }

  const READ_TOOLS = new Set([
    "file_read",
    "glob",
    "grep",
    "list_dir",
    "git_status",
    "git_diff",
    "git_log",
    "memory",
  ]);
  const WRITE_TOOLS = new Set([
    "file_write",
    "file_edit",
    "multi_edit",
    "batch_edit",
    "shell",
  ]);

  return {
    name: "fleet-signals",

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      const signals = fleetState.get(sid);
      if (!signals) return;

      signals.lastActivity = Date.now();

      if (READ_TOOLS.has(result.name)) signals.readCount++;
      if (WRITE_TOOLS.has(result.name)) signals.writeCount++;

      if (result.ok) {
        signals.toolSuccesses++;
      } else {
        signals.toolFailures++;
      }
    },
  };
}

/** Get fleet-level dashboard for daemon tick messages. */
export function getFleetDashboard(): {
  activeSessions: number;
  avgReadEditRatio: number;
  totalFailures: number;
  degradedSessions: string[];
} {
  const now = Date.now();
  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  const active = [...fleetState.values()].filter(
    (s) => now - s.lastActivity < STALE_THRESHOLD_MS,
  );

  const ratios = active
    .filter((s) => s.writeCount > 0)
    .map((s) => s.readCount / s.writeCount);

  const avgRatio =
    ratios.length > 0
      ? ratios.reduce((a, b) => a + b, 0) / ratios.length
      : Infinity;

  const degraded = active
    .filter((s) => s.writeCount >= 3 && s.readCount / s.writeCount < 3.0)
    .map((s) => s.sessionId);

  return {
    activeSessions: active.length,
    avgReadEditRatio: Math.round(avgRatio * 10) / 10,
    totalFailures: active.reduce((sum, s) => sum + s.toolFailures, 0),
    degradedSessions: degraded,
  };
}

/** Clear stale sessions from fleet state. */
export function pruneFleetState(): void {
  const now = Date.now();
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  for (const [id, signals] of fleetState) {
    if (now - signals.lastActivity > STALE_THRESHOLD_MS) {
      fleetState.delete(id);
    }
  }
}
