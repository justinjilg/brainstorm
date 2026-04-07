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
import { createLogger } from "@brainst0rm/shared";

export interface ModelStats {
  successes: number;
  failures: number;
  totalLatencyMs: number;
  totalCost: number;
  samples: number;
}

const log = createLogger("learned-strategy");

// In-memory stats — loaded from DB on init, updated per-turn, persisted per-outcome
const modelStats = new Map<string, ModelStats>();

// ── Audit Trail ────────────────────────────────────────────────────

export interface OutcomeAuditEntry {
  timestamp: number;
  taskType: string;
  modelId: string;
  success: boolean;
  latencyMs: number;
  cost: number;
}

export interface ConvergenceAlert {
  type: "suspicious_convergence" | "outcome_bias" | "rapid_shift";
  taskType: string;
  detail: string;
  timestamp: number;
}

const auditLog: OutcomeAuditEntry[] = [];
const convergenceAlerts: ConvergenceAlert[] = [];
const MAX_AUDIT_ENTRIES = 500;

/** Threshold: if one model gets >80% of recent outcomes, flag it. */
const CONVERGENCE_THRESHOLD = 0.8;
/** Minimum samples before checking convergence. */
const MIN_CONVERGENCE_SAMPLES = 10;

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

  // Audit trail: log every outcome
  const entry: OutcomeAuditEntry = {
    timestamp: Date.now(),
    taskType,
    modelId,
    success,
    latencyMs,
    cost,
  };
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_ENTRIES);
  }

  // Convergence detection: check if one model dominates recent outcomes
  checkConvergence(taskType);
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

/**
 * Check for suspicious convergence on a single model for a task type.
 * If one model gets >80% of recent outcomes, something may be gaming the sampler.
 */
function checkConvergence(taskType: string): void {
  // Get recent outcomes for this task type
  const recent = auditLog.filter((e) => e.taskType === taskType).slice(-50);

  if (recent.length < MIN_CONVERGENCE_SAMPLES) return;

  // Count outcomes per model
  const modelCounts = new Map<string, number>();
  for (const entry of recent) {
    modelCounts.set(entry.modelId, (modelCounts.get(entry.modelId) ?? 0) + 1);
  }

  // Check if any model dominates
  for (const [modelId, count] of modelCounts) {
    const ratio = count / recent.length;
    if (ratio >= CONVERGENCE_THRESHOLD) {
      // Only alert once per model/taskType (deduplicate within last 10 alerts)
      const recentAlerts = convergenceAlerts.slice(-10);
      const isDuplicate = recentAlerts.some(
        (a) =>
          a.taskType === taskType &&
          a.detail.includes(modelId) &&
          Date.now() - a.timestamp < 300_000, // 5-minute dedup window
      );

      if (!isDuplicate) {
        const alert: ConvergenceAlert = {
          type: "suspicious_convergence",
          taskType,
          detail: `Model ${modelId} received ${(ratio * 100).toFixed(0)}% of last ${recent.length} outcomes for "${taskType}". Possible Thompson sampling poisoning or natural convergence.`,
          timestamp: Date.now(),
        };
        convergenceAlerts.push(alert);

        log.warn(
          { taskType, modelId, ratio, sampleCount: recent.length },
          "Suspicious convergence detected in Thompson sampling",
        );
      }
    }
  }

  // Check for rapid shift: if model selection changed >3 times in last 10 outcomes
  if (recent.length >= 10) {
    const last10 = recent.slice(-10);
    let shifts = 0;
    for (let i = 1; i < last10.length; i++) {
      if (last10[i].modelId !== last10[i - 1].modelId) shifts++;
    }
    if (shifts > 6) {
      const recentAlerts = convergenceAlerts.slice(-10);
      const isDuplicate = recentAlerts.some(
        (a) =>
          a.type === "rapid_shift" &&
          a.taskType === taskType &&
          Date.now() - a.timestamp < 300_000,
      );

      if (!isDuplicate) {
        convergenceAlerts.push({
          type: "rapid_shift",
          taskType,
          detail: `${shifts} model switches in last 10 outcomes for "${taskType}". Sampling may be unstable.`,
          timestamp: Date.now(),
        });
      }
    }
  }
}

/**
 * Get the audit log for external inspection.
 */
export function getOutcomeAuditLog(limit = 100): OutcomeAuditEntry[] {
  return auditLog.slice(-limit);
}

/**
 * Get convergence alerts.
 */
export function getConvergenceAlerts(limit = 20): ConvergenceAlert[] {
  return convergenceAlerts.slice(-limit);
}

/**
 * Get a summary of model distribution for a task type.
 */
export function getModelDistribution(
  taskType: string,
): Array<{ modelId: string; count: number; successRate: number }> {
  const entries = auditLog.filter((e) => e.taskType === taskType);
  const models = new Map<string, { count: number; successes: number }>();

  for (const entry of entries) {
    const stat = models.get(entry.modelId) ?? { count: 0, successes: 0 };
    stat.count++;
    if (entry.success) stat.successes++;
    models.set(entry.modelId, stat);
  }

  return Array.from(models.entries())
    .map(([modelId, stat]) => ({
      modelId,
      count: stat.count,
      successRate: stat.count > 0 ? stat.successes / stat.count : 0,
    }))
    .sort((a, b) => b.count - a.count);
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
