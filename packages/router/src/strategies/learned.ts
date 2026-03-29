/**
 * Learned Routing Strategy — Client-side Thompson Sampling.
 *
 * Records (taskType, modelId, success, latency, cost) per turn.
 * Uses Beta distribution sampling to balance exploration vs exploitation.
 * BrainstormRouter does server-side sampling — this brings it client-side.
 */

import type {
  TaskProfile,
  ModelEntry,
  RoutingContext,
  RoutingDecision,
} from "@brainst0rm/shared";
import type { RoutingStrategy } from "./types.js";

interface ModelStats {
  successes: number;
  failures: number;
  totalLatencyMs: number;
  totalCost: number;
  samples: number;
}

// In-memory stats — persisted to session_patterns table via SessionPatternLearner
const modelStats = new Map<string, ModelStats>();

/**
 * Record an outcome for a model on a task type.
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

export const learnedStrategy: RoutingStrategy = {
  name: "learned",

  select(
    task: TaskProfile,
    candidates: ModelEntry[],
    context: RoutingContext,
  ): RoutingDecision | null {
    const eligible = candidates.filter((m) => m.status === "available");
    if (eligible.length === 0) return null;

    // Score each model using Thompson sampling
    const scored = eligible.map((model) => {
      const key = `${task.type}:${model.id}`;
      const stats = modelStats.get(key);

      // No history → high exploration score (optimistic prior)
      const sample = stats
        ? betaSample(stats.successes, stats.failures)
        : 0.7 + Math.random() * 0.3;

      return { model, sample };
    });

    // Pick the model with highest sampled score
    scored.sort((a, b) => b.sample - a.sample);
    const selected = scored[0].model;

    return {
      model: selected,
      fallbacks: scored.slice(1, 3).map((s) => s.model),
      strategy: "learned",
      reason: `Thompson sampling (score: ${scored[0].sample.toFixed(3)}, ${modelStats.get(`${task.type}:${selected.id}`)?.samples ?? 0} samples)`,
      estimatedCost: 0,
    };
  },
};
