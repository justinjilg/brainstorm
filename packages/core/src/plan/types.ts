/**
 * Plan execution types — the data model for autonomous multi-model plan execution.
 *
 * Hierarchy: PlanFile → Epoch → Phase → Sprint → Task
 * Each level has status, cost tracking, and rollup progress.
 */

import type { SubagentType } from "../agent/subagent.js";

// ── Plan Node Status ────────────────────────────────────────────────

export type PlanNodeStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

// ── Plan Hierarchy ──────────────────────────────────────────────────

export interface PlanFile {
  id: string;
  filePath: string;
  name: string;
  status: PlanNodeStatus;
  createdDate?: string;
  targetDate?: string;
  phases: PlanPhase[];
  totalTasks: number;
  completedTasks: number;
}

export interface PlanPhase {
  id: string;
  name: string;
  status: PlanNodeStatus;
  startDate?: string;
  sprints: PlanSprint[];
  taskCount: number;
  completedCount: number;
}

export interface PlanSprint {
  id: string;
  name: string;
  status: PlanNodeStatus;
  tasks: PlanTask[];
}

export interface PlanTask {
  id: string;
  description: string;
  status: PlanNodeStatus;
  assignedSkill?: string;
  cost?: number;
  modelUsed?: string;
  startedAt?: number;
  completedAt?: number;
  readonly?: boolean;
  metadata: Record<string, string>;
  /** Line number in the plan file (for write-back) */
  lineNumber: number;
}

// ── Task Dispatch ───────────────────────────────────────────────────

export interface TaskDispatch {
  subagentType: SubagentType;
  modelHint: "cheap" | "capable" | "quality";
  requiresVerification: boolean;
  routingStrategy?: string;
}

// ── Plan Executor Options ───────────────────────────────────────────

export interface PlanExecutorOptions {
  projectPath: string;
  buildCommand?: string;
  testCommand?: string;
  defaultBudgetPerTask: number;
  planBudgetLimit?: number;
  mode: "interactive" | "autonomous" | "dry-run";
  maxRetries: number;
  compactBetweenPhases: boolean;
}

// ── Plan Events ─────────────────────────────────────────────────────

export type PlanEvent =
  | { type: "plan-started"; plan: PlanFile; totalTasks: number }
  | { type: "phase-started"; phase: PlanPhase }
  | { type: "phase-completed"; phase: PlanPhase; cost: number }
  | { type: "sprint-started"; sprint: PlanSprint }
  | {
      type: "task-started";
      task: PlanTask;
      subagentType: string;
      model: string;
    }
  | {
      type: "task-completed";
      task: PlanTask;
      cost: number;
      summary: string;
      model: string;
      toolCalls: string[];
    }
  | {
      type: "task-failed";
      task: PlanTask;
      reason: string;
      error?: string;
    }
  | { type: "task-budget-exceeded"; task: PlanTask; cost: number }
  | {
      type: "task-retrying";
      task: PlanTask;
      model: string;
      attempt: number;
    }
  | { type: "build-check"; passed: boolean; output?: string }
  | { type: "plan-completed"; plan: PlanFile; totalCost: number }
  | { type: "plan-paused"; reason: string }
  | { type: "skill-activated"; skillName: string; taskId: string }
  | {
      type: "dry-run-task";
      task: PlanTask;
      dispatch: TaskDispatch;
      estimatedCost: number;
    }
  | {
      type: "dry-run-summary";
      totalTasks: number;
      estimatedCost: number;
      tasksByType: Record<string, number>;
    };
