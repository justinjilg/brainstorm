import type { ModelEntry, CapabilityScores } from '@brainstorm/shared';
import type { Subtask } from '@brainstorm/agents';

/** Minimum capability score threshold for a model to be eligible for a subtask. */
const DEFAULT_CAPABILITY_THRESHOLD = 0.6;

/** Map subtask capability requirements to CapabilityScores dimensions. */
const CAPABILITY_MAP: Record<string, keyof CapabilityScores> = {
  'tool-calling': 'toolSelection',
  'reasoning': 'multiStepReasoning',
  'code-generation': 'codeGeneration',
  'large-context': 'contextUtilization',
  'vision': 'contextUtilization', // no direct vision score — use context as proxy
};

export interface TeamAssignment {
  subtaskId: string;
  modelId: string;
  modelName: string;
  estimatedCost: number;
  capabilityMatch: number;
}

export interface TeamComposition {
  assignments: TeamAssignment[];
  totalEstimatedCost: number;
  baselineCost: number;
  savings: number;
  savingsPercent: number;
}

/**
 * Find the cheapest combination of models that meets capability thresholds
 * for each subtask in a decomposed workflow.
 *
 * @param subtasks — From the orchestrator's decomposition
 * @param models — All available models
 * @param baselineModelId — The "just run everything on one model" baseline
 * @param threshold — Minimum capability score (default 0.6)
 */
export function optimizeTeamComposition(
  subtasks: Subtask[],
  models: ModelEntry[],
  baselineModelId?: string,
  threshold: number = DEFAULT_CAPABILITY_THRESHOLD,
): TeamComposition {
  const available = models.filter((m) => m.status === 'available');
  const assignments: TeamAssignment[] = [];

  for (const subtask of subtasks) {
    const requiredDims = subtask.requiredCapabilities
      .map((cap) => CAPABILITY_MAP[cap])
      .filter(Boolean);

    // Score each model on the required dimensions
    const scored = available.map((model) => {
      const scores = model.capabilities.capabilityScores;
      if (!scores || requiredDims.length === 0) {
        return { model, match: 0.5, cost: estimateSubtaskCost(model, subtask) };
      }

      const dimScores = requiredDims.map((dim) => scores[dim] ?? 0.5);
      const avgScore = dimScores.reduce((s, v) => s + v, 0) / dimScores.length;

      return { model, match: avgScore, cost: estimateSubtaskCost(model, subtask) };
    });

    // Filter to models meeting the threshold
    const eligible = scored.filter((s) => s.match >= threshold);

    // If no model meets threshold, take the best available
    const candidates = eligible.length > 0 ? eligible : scored;

    // Pick cheapest among eligible
    candidates.sort((a, b) => a.cost - b.cost);
    const best = candidates[0];

    assignments.push({
      subtaskId: subtask.id,
      modelId: best.model.id,
      modelName: best.model.name,
      estimatedCost: best.cost,
      capabilityMatch: best.match,
    });
  }

  const totalEstimatedCost = assignments.reduce((sum, a) => sum + a.estimatedCost, 0);

  // Compute baseline: run everything on the baseline model (or most expensive)
  const baseline = baselineModelId
    ? available.find((m) => m.id === baselineModelId)
    : available.sort((a, b) => b.pricing.outputPer1MTokens - a.pricing.outputPer1MTokens)[0];

  const baselineCost = baseline
    ? subtasks.reduce((sum, st) => sum + estimateSubtaskCost(baseline, st), 0)
    : totalEstimatedCost;

  const savings = baselineCost - totalEstimatedCost;
  const savingsPercent = baselineCost > 0 ? (savings / baselineCost) * 100 : 0;

  return {
    assignments,
    totalEstimatedCost,
    baselineCost,
    savings,
    savingsPercent: Math.round(savingsPercent),
  };
}

/** Rough cost estimate for a subtask on a given model. */
function estimateSubtaskCost(model: ModelEntry, subtask: Subtask): number {
  const tokens = subtask.estimatedTokens ?? getDefaultTokens(subtask.complexity);
  const inputTokens = tokens * 0.6;
  const outputTokens = tokens * 0.4;
  return (
    (inputTokens / 1_000_000) * model.pricing.inputPer1MTokens +
    (outputTokens / 1_000_000) * model.pricing.outputPer1MTokens
  );
}

function getDefaultTokens(complexity: string): number {
  switch (complexity) {
    case 'trivial': return 500;
    case 'simple': return 2000;
    case 'moderate': return 5000;
    case 'complex': return 15000;
    default: return 3000;
  }
}
