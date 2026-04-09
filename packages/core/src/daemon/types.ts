/**
 * KAIROS Daemon Types — model-driven timing for Brainstorm.
 */

import type { DaemonConfig } from "@brainst0rm/config";
import type { AgentEvent } from "@brainst0rm/shared";

export type DaemonStatus = "running" | "sleeping" | "paused" | "stopped";
export type WakeTrigger = "timer" | "user" | "scheduler";

export interface DaemonState {
  status: DaemonStatus;
  tickCount: number;
  totalCost: number;
  sleepUntil: number | null;
  sleepReason: string | null;
  lastTickAt: number | null;
  lastWakeTrigger: WakeTrigger | null;
  sessionStartedAt: number;
  isPaused: boolean;
}

export interface TickResult {
  tickNumber: number;
  events: AgentEvent[];
  cost: number;
  modelUsed: string;
  sleepRequested?: { ms: number; reason: string };
  toolCalls: string[];
}

export interface DaemonControllerOptions {
  config: DaemonConfig;
  sessionId: string;
  projectPath: string;
  /** Callback to run the agent loop for one tick. */
  runTick: (tickMessage: string) => AsyncGenerator<AgentEvent>;
  /** Optional: get due scheduled tasks to include in tick. */
  getDueTasks?: () => string[];
  /** Optional: get pending task summaries. */
  getPendingTasks?: () => string[];
  /** Optional: get today's log summary for context. */
  getLogSummary?: () => string;
  /** Optional: get memory summary for tick context. */
  getMemorySummary?: () => string;
  /** Optional: get available skills for autonomous invocation. */
  getAvailableSkills?: () => Array<{ name: string; description: string }>;
  /** Called on each tick for persistence. */
  onTickComplete?: (result: TickResult) => void | Promise<void>;
  /** Called when daemon state changes. */
  onStateChange?: (state: DaemonState) => void | Promise<void>;
  /** Hook callback for DaemonTick/DaemonSleep events. */
  onHook?: (
    event: "DaemonTick" | "DaemonSleep",
    context: { tickNumber?: number; sleepMs?: number; cost?: number },
  ) => Promise<void>;
  /**
   * Called when memory reflection is due (every reflectionInterval ticks, default 50).
   * The callback should trigger the dream/reflection subagent.
   */
  onReflectionDue?: (tickNumber: number) => Promise<void>;
  /** Number of ticks between reflection triggers (default: 50). */
  reflectionInterval?: number;
  /**
   * Number of ticks between mandatory human review gates (default: 0 = disabled).
   * When set, the daemon pauses every N ticks and calls onApprovalGate
   * with a summary of recent activity. The daemon stays paused until
   * the human explicitly resumes.
   */
  approvalGateInterval?: number;
  /**
   * Called when an approval gate is reached. Should present a summary
   * to the human and return true to continue or false to stop the daemon.
   */
  onApprovalGate?: (context: ApprovalGateContext) => Promise<boolean>;

  // ── KAIROS ↔ BR Intelligence Loop ──

  /**
   * Get current model momentum from the router.
   * Enables cost-paced sleep and momentum-aware approval gates.
   */
  getRouterIntelligence?: () => {
    momentum: {
      modelId: string;
      successCount: number;
      taskType: string;
    } | null;
    recentFailureCount: number;
    convergenceAlerts: string[];
  };

  /**
   * Get cost-pacing advice from the cost tracker.
   * Returns advised sleep interval based on budget velocity.
   */
  getCostPacing?: (defaultIntervalMs: number) => {
    intervalMs: number;
    reason: string;
    budgetPressure: number;
    /** True when budget is exhausted — daemon should stop. */
    shouldStop: boolean;
  };

  /**
   * Checkpoint daemon state before each tick for crash recovery.
   * Write tickCount, totalCost, status to durable storage.
   * On restart, restore from the last checkpoint.
   */
  onCheckpoint?: (state: DaemonState) => Promise<void>;
}

export interface ApprovalGateContext {
  /** Current tick number. */
  tickNumber: number;
  /** Number of ticks since last gate (or session start). */
  ticksSinceLastGate: number;
  /** Total cost accumulated since last gate. */
  costSinceLastGate: number;
  /** Tool calls made since last gate. */
  toolCallsSinceLastGate: string[];
  /** Total session cost. */
  totalCost: number;
  /** Session duration in ms. */
  sessionDurationMs: number;

  // ── Router Intelligence (KAIROS ↔ BR feedback loop) ──

  /** Current model momentum — how well the active model is performing. */
  modelMomentum: {
    modelId: string;
    successCount: number;
    taskType: string;
  } | null;
  /** Recent model failures (last 60s). */
  recentFailures: number;
  /** Budget pressure: 0.0 (healthy) to 1.0 (exhausted). */
  budgetPressure: number;
  /** Whether cost pacing has kicked in (intervals stretched). */
  costPacingActive: boolean;
  /** Thompson sampling convergence alerts, if any. */
  convergenceAlerts?: string[];
}

export function createInitialState(): DaemonState {
  return {
    status: "running",
    tickCount: 0,
    totalCost: 0,
    sleepUntil: null,
    sleepReason: null,
    lastTickAt: null,
    lastWakeTrigger: null,
    sessionStartedAt: Date.now(),
    isPaused: false,
  };
}
