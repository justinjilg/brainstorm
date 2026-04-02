/**
 * Budget inference and tracking for the onboard pipeline.
 *
 * Auto-infers a budget cap from project size (file count + complexity),
 * then tracks spend per-phase to prevent cost overruns.
 */

import type { ProjectAnalysis } from "@brainst0rm/ingest";

export interface BudgetTracker {
  /** Total budget in USD. */
  total: number;
  /** Amount spent so far. */
  spent: number;
  /** Remaining budget. */
  remaining: number;
  /** Whether there's enough budget for an estimated cost. */
  canAfford(estimatedCost: number): boolean;
  /** Record a spend. Returns false if budget exceeded. */
  record(cost: number): boolean;
}

/**
 * Infer a reasonable budget from project analysis.
 *
 * Small projects (<50 files): $2.00
 * Medium projects (<500 files): $5.00
 * Large projects (500+): $10.00
 *
 * Complexity multiplier: high-complexity projects get 1.5x.
 */
export function inferBudget(analysis: ProjectAnalysis): number {
  const files = analysis.summary.totalFiles;
  const complexity = analysis.summary.avgComplexity;

  let base: number;
  if (files < 50) base = 2.0;
  else if (files < 500) base = 5.0;
  else base = 10.0;

  // High-complexity projects (avg > 15) get a bump
  const multiplier = complexity > 15 ? 1.5 : 1.0;

  return Math.round(base * multiplier * 100) / 100;
}

/**
 * Create a budget tracker for the pipeline.
 */
export function createBudgetTracker(totalBudget: number): BudgetTracker {
  let spent = 0;

  return {
    get total() {
      return totalBudget;
    },
    get spent() {
      return Math.round(spent * 1000) / 1000;
    },
    get remaining() {
      return Math.round((totalBudget - spent) * 1000) / 1000;
    },
    canAfford(estimatedCost: number): boolean {
      return spent + estimatedCost <= totalBudget;
    },
    record(cost: number): boolean {
      spent += cost;
      return spent <= totalBudget;
    },
  };
}

/** Per-phase cost estimates (USD) for budget planning. */
export const PHASE_COST_ESTIMATES: Record<string, number> = {
  "static-analysis": 0,
  "deep-exploration": 0.25,
  "team-assembly": 0.4,
  "routing-rules": 0.06,
  "workflow-gen": 0.08,
  "brainstorm-md": 0.15,
  verification: 0,
};
