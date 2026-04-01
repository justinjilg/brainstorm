/**
 * Learned Routing Strategy — Client-side Thompson Sampling.
 *
 * Records (taskType, modelId, success, latency, cost) per turn.
 * Uses Beta distribution sampling to balance exploration vs exploitation.
 * Stats are persisted to model_performance_v2 via RoutingOutcomeRepository
 * and loaded on router init for cross-session learning.
 */

import type {
  TaskProfile,
  ModelEntry,
  RoutingContext,
  RoutingDecision,
} from "@brainst0rm/shared";
import type { RoutingStrategy } from "./types.js";

export interface ModelStats {
  successes: number;
  failures: number;
  totalLatencyMs: number;
  totalCost: number;
  samples: number;
}

// In-memory stats — loaded from DB on init, updated per-turn, persisted per-outcome
const modelStats = new Map<string, ModelStats>();

/**
 * Load historical stats from aggregated DB data.
 * Called once during router initialization.
 */
export function loadStats(
  aggregated: Array<{
    taskType: string;
    modelId: string;
    successes: number;
    failures: number;
    avgLatencyMs: number;
    avgCost: number;
    samples: number;
  }>,
): void {
  modelStats.clear();
  for (const row of aggregated) {
    const key = `${row.taskType}:${row.modelId}`;
    modelStats.set(key, {
      successes: row.successes,
      failures: row.failures,
      totalLatencyMs: row.avgLatencyMs * row.samples,
      totalCost: row.avgCost * row.samples,
      samples: row.samples,
    });
  }
}

/**
 * Record an outcome for a model on a task type.
 * Updates in-memory stats immediately. Caller is responsible for DB persistence.
 */
export function recordOutcome(
  taskType: string,
  modelId: string,
  success: boolean,
  latencyMs: number,
  cost: number,
): void {
  const key = `${taskType}:${modelId}`;
  const stats = modelStats.get(key) ?? {
    successes: 0,
    failures: 0,
    totalLatencyMs: 0,
    totalCost: 0,
    samples: 0,
  };

  if (success) stats.successes++;
  else stats.failures++;
  stats.totalLatencyMs += latencyMs;
  stats.totalCost += cost;
  stats.samples++;

  modelStats.set(key, stats);
}

/**
 * Get total sample count across all task_type:model pairs.
 * Used to determine if learned strategy has enough data.
 */
export function getTotalSamples(): number {
  let total = 0;
  for (const stats of modelStats.values()) {
    total += stats.samples;
  }
  return total;
}

/**
 * Get sample count for a specific task type (across all models).
 * Used by combined strategy to decide whether to delegate to learned.
 */
export function getSamplesForTaskType(taskType: string): number {
  let total = 0;
  for (const [key, stats] of modelStats.entries()) {
    if (key.startsWith(`${taskType}:`)) {
      total += stats.samples;
    }
  }
  return total;
}

/**
 * Sample from Beta(successes+1, failures+1) distribution.
 * Uses Gamma-ratio method: Beta(a,b) = Ga/(Ga+Gb) where Ga~Gamma(a), Gb~Gamma(b).
 */
function betaSample(successes: number, failures: number): number {
  const a = gammaSample(successes + 1);
  const b = gammaSample(failures + 1);
  return a / (a + b);
}

/** Box-Muller normal sample. */
function randn(): number {
  return (
    Math.sqrt(-2 * Math.log(Math.random())) *
    Math.cos(2 * Math.PI * Math.random())
  );
}

/** Marsaglia-Tsang Gamma sampler (shape >= 1; recursion for shape < 1). */
function gammaSample(shape: number): number {
  if (shape < 1) return gammaSample(1 + shape) * Math.random() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Weight given to cost efficiency in the final score (0 = ignore cost, 1 = cost dominates). */
const COST_WEIGHT = 0.25;

export const learnedStrategy: RoutingStrategy = {
  name: "learned",

  select(
    task: TaskProfile,
    candidates: ModelEntry[],
    context: RoutingContext,
  ): RoutingDecision | null {
    const eligible = candidates.filter((m) => m.status === "available");
    if (eligible.length === 0) return null;

    // Collect raw scores and avg costs
    const raw = eligible.map((model) => {
      const key = `${task.type}:${model.id}`;
      const stats = modelStats.get(key);

      // Thompson sample for success probability
      const successSample = stats
        ? betaSample(stats.successes, stats.failures)
        : 0.7 + Math.random() * 0.3;

      // Average cost per turn (from historical data, or estimate from pricing)
      const avgCost =
        stats && stats.samples > 0
          ? stats.totalCost / stats.samples
          : (task.estimatedTokens.input / 1_000_000) *
              model.pricing.inputPer1MTokens +
            (task.estimatedTokens.output / 1_000_000) *
              model.pricing.outputPer1MTokens;

      return { model, successSample, avgCost, samples: stats?.samples ?? 0 };
    });

    // Normalize cost to [0, 1] range (0 = cheapest, 1 = most expensive)
    const maxCost = Math.max(...raw.map((r) => r.avgCost), 0.0001);
    const scored = raw.map((r) => {
      const costPenalty = r.avgCost / maxCost; // 0..1
      // Final score: success probability with cost penalty
      // A model with 95% success at $15/M gets penalized vs 90% success at $0.50/M
      const score = r.successSample * (1 - COST_WEIGHT * costPenalty);
      return { ...r, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const selected = scored[0];

    return {
      model: selected.model,
      fallbacks: scored.slice(1, 3).map((s) => s.model),
      strategy: "learned",
      reason: `Thompson sampling (score: ${selected.score.toFixed(3)}, success: ${selected.successSample.toFixed(3)}, cost: $${selected.avgCost.toFixed(4)}, ${selected.samples} samples)`,
      estimatedCost: selected.avgCost,
    };
  },
};
