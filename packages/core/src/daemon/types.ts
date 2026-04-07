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
