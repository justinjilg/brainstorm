/**
 * Cost Prediction — estimate task cost before execution.
 *
 * Uses task classification + model pricing + historical patterns to predict
 * how much a task will cost across different model tiers.
 *
 * Market's #1 pain point: "How much will this cost?"
 * BrainstormRouter advantage: historical routing data enables predictions
 * like "refactoring in a Next.js project typically costs $0.08 with Sonnet."
 */

import type { TaskProfile, ModelEntry, Complexity } from '@brainstorm/shared';

export interface CostPrediction {
  /** Best estimate for the task. */
  estimated: number;
  /** Confidence range [low, high]. */
  range: [number, number];
  /** Per-tier breakdown. */
  tiers: CostTier[];
  /** Task type used for prediction. */
  taskType: string;
  /** Complexity level. */
  complexity: string;
}

export interface CostTier {
  label: string;
  model: string;
  estimatedCost: number;
  estimatedTokens: number;
  estimatedLatencyMs: number;
}

/** Average tokens per task complexity (heuristic from typical coding tasks). */
const COMPLEXITY_TOKENS: Record<Complexity, { input: number; output: number; turns: number }> = {
  trivial: { input: 500, output: 200, turns: 1 },
  simple: { input: 2000, output: 800, turns: 2 },
  moderate: { input: 8000, output: 3000, turns: 4 },
  complex: { input: 25000, output: 10000, turns: 8 },
  expert: { input: 60000, output: 25000, turns: 15 },
};

/**
 * Predict the cost of a task before execution.
 *
 * @param taskProfile - Classified task profile from the router
 * @param models - Available models with pricing
 * @returns Cost prediction with per-tier breakdown
 */
export function predictTaskCost(
  taskProfile: TaskProfile,
  models: ModelEntry[],
): CostPrediction {
  const tokenEstimate = COMPLEXITY_TOKENS[taskProfile.complexity];
  const totalInput = tokenEstimate.input * tokenEstimate.turns;
  const totalOutput = tokenEstimate.output * tokenEstimate.turns;

  // Find representative models for each tier
  const qualityModel = findModelByTier(models, 'quality');
  const balancedModel = findModelByTier(models, 'balanced');
  const cheapModel = findModelByTier(models, 'cheap');

  const tiers: CostTier[] = [];

  if (qualityModel) {
    tiers.push(buildTier('Quality', qualityModel, totalInput, totalOutput));
  }
  if (balancedModel) {
    tiers.push(buildTier('Balanced', balancedModel, totalInput, totalOutput));
  }
  if (cheapModel) {
    tiers.push(buildTier('Budget', cheapModel, totalInput, totalOutput));
  }

  // Best estimate uses balanced model (or quality if no balanced)
  const primary = tiers.find((t) => t.label === 'Balanced') ?? tiers[0];
  const estimated = primary?.estimatedCost ?? 0;

  // Range: cheapest to most expensive tier
  const costs = tiers.map((t) => t.estimatedCost).filter((c) => c > 0);
  const range: [number, number] = costs.length > 0
    ? [Math.min(...costs), Math.max(...costs)]
    : [0, 0];

  return {
    estimated,
    range,
    tiers,
    taskType: taskProfile.type,
    complexity: taskProfile.complexity,
  };
}

/**
 * Format a cost prediction for display.
 */
export function formatCostPrediction(prediction: CostPrediction): string {
  if (prediction.tiers.length === 0) return 'Cost estimate unavailable.';

  const lines = [`Est. cost (${prediction.complexity} ${prediction.taskType}):`];
  for (const tier of prediction.tiers) {
    lines.push(`  ${tier.label}: $${tier.estimatedCost.toFixed(3)} (${tier.model})`);
  }
  return lines.join('\n');
}

function buildTier(label: string, model: ModelEntry, inputTokens: number, outputTokens: number): CostTier {
  const inputCost = (inputTokens / 1_000_000) * (model.pricing?.inputPer1MTokens ?? 0);
  const outputCost = (outputTokens / 1_000_000) * (model.pricing?.outputPer1MTokens ?? 0);

  return {
    label,
    model: model.id,
    estimatedCost: inputCost + outputCost,
    estimatedTokens: inputTokens + outputTokens,
    estimatedLatencyMs: estimateLatency(model, inputTokens + outputTokens),
  };
}

function findModelByTier(models: ModelEntry[], tier: 'quality' | 'balanced' | 'cheap'): ModelEntry | undefined {
  // Sort by output price
  const sorted = [...models]
    .filter((m) => m.pricing?.outputPer1MTokens)
    .sort((a, b) => (a.pricing?.outputPer1MTokens ?? 0) - (b.pricing?.outputPer1MTokens ?? 0));

  if (sorted.length === 0) return undefined;

  if (tier === 'cheap') return sorted[0];
  if (tier === 'quality') return sorted[sorted.length - 1];
  // Balanced: middle of the pack
  return sorted[Math.floor(sorted.length / 2)];
}

function estimateLatency(model: ModelEntry, totalTokens: number): number {
  // Rough estimate: 50 tokens/sec for cloud, 20 tokens/sec for local
  const tokensPerSec = model.provider === 'local' ? 20 : 50;
  return Math.round((totalTokens / tokensPerSec) * 1000);
}
