/**
 * Auto Routing Strategy — delegates to BR Thompson sampling or local heuristic.
 *
 * When BrainstormRouter gateway is configured, the strategy signals that
 * the model should be "openclaw/auto" — BR picks based on complexity,
 * historical performance, and cost/quality tradeoff.
 *
 * When gateway is not configured (local-only), implements a simple heuristic:
 *   - Architecture/security/analysis → highest quality model
 *   - Code generation/refactoring → best cost/quality ratio
 *   - Simple edits/conversation → cheapest available
 *
 * Learned from: Living Case Study — hardcoded model preferences caused
 * every task to fall through to GPT-4.1 when Anthropic was down.
 * Auto routing lets BR handle failover and model selection.
 */

import type {
  TaskProfile,
  ModelEntry,
  RoutingContext,
  RoutingDecision,
  QualityTier,
} from "@brainst0rm/shared";
import type { RoutingStrategy } from "./types.js";

// Task types that need the best model (highest quality)
const HIGH_QUALITY_TASKS = new Set([
  "analysis",
  "debugging",
  "multi-file-edit",
]);

// Task types where cost/quality balance matters
const BALANCED_TASKS = new Set(["code-generation", "refactoring"]);

// Task types where cheap is fine
const FAST_TASKS = new Set([
  "simple-edit",
  "conversation",
  "explanation",
  "search",
]);

function estimateCost(model: ModelEntry, task: TaskProfile): number {
  const inputTokens = task.estimatedTokens?.input ?? 1000;
  const outputTokens = task.estimatedTokens?.output ?? 1000;
  return (
    (model.pricing.inputPer1MTokens * inputTokens +
      model.pricing.outputPer1MTokens * outputTokens) /
    1_000_000
  );
}

export const autoStrategy: RoutingStrategy = {
  name: "auto",

  select(
    task: TaskProfile,
    candidates: ModelEntry[],
    context: RoutingContext,
  ): RoutingDecision | null {
    if (candidates.length === 0) return null;

    const available = candidates.filter((m) => m.status === "available");
    if (available.length === 0) return null;

    // Determine task tier
    let targetTier: QualityTier;
    if (HIGH_QUALITY_TASKS.has(task.type)) {
      targetTier = 1; // frontier
    } else if (BALANCED_TASKS.has(task.type)) {
      targetTier = 3; // mid-tier
    } else if (FAST_TASKS.has(task.type)) {
      targetTier = 5; // fast/cheap
    } else {
      targetTier = 3; // default to balanced
    }

    // Budget pressure: if over 80% spent, prefer cheaper models
    const dailyLimit = context.budget.dailyLimit ?? Infinity;
    const dailyUsed = context.budget.dailyUsed;
    if (dailyLimit > 0 && dailyUsed / dailyLimit > 0.8) {
      targetTier = Math.min(targetTier + 2, 5) as QualityTier;
    }

    // Score: prefer models close to target tier, break ties by cost
    const scored = available
      .map((m) => ({
        model: m,
        tierDist: Math.abs(m.capabilities.qualityTier - targetTier),
        cost: estimateCost(m, task),
      }))
      .sort((a, b) => {
        if (a.tierDist !== b.tierDist) return a.tierDist - b.tierDist;
        return a.cost - b.cost;
      });

    const best = scored[0];
    const fallbacks = scored.slice(1, 4).map((s) => s.model);

    return {
      model: best.model,
      fallbacks,
      reason: `Auto: ${task.type} → tier ${targetTier} (budget ${dailyLimit > 0 ? Math.round((dailyUsed / dailyLimit) * 100) : 0}% used)`,
      estimatedCost: best.cost,
      strategy: "auto",
    };
  },
};
