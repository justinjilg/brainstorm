import type { TaskProfile, ModelEntry, RoutingContext, RoutingDecision } from '@brainstorm/shared';
import type { RoutingStrategy } from './types.js';

export const qualityFirstStrategy: RoutingStrategy = {
  name: 'quality-first',

  select(task: TaskProfile, candidates: ModelEntry[], context: RoutingContext): RoutingDecision | null {
    let available = candidates.filter((m) => m.status === 'available');
    if (available.length === 0) return null;

    // Prefer explicit models over brainstormrouter/auto.
    // Auto is a black box — we can't predict which model it picks, and the
    // user is paying for a key that gives access to specific quality models.
    // Keep auto only as a last resort.
    if (available.length > 1) {
      const explicit = available.filter((m) => m.id !== 'brainstormrouter/auto');
      if (explicit.length > 0) available = explicit;
    }

    // Sort by quality tier (1 = best) then speed
    const sorted = available.sort((a, b) => {
      if (a.capabilities.qualityTier !== b.capabilities.qualityTier) {
        return a.capabilities.qualityTier - b.capabilities.qualityTier;
      }
      return a.capabilities.speedTier - b.capabilities.speedTier;
    });

    // Filter out models that would exceed budget
    const withinBudget = sorted.filter((m) => {
      const cost = estimateCost(m, task);
      if (context.budget.sessionLimit && context.budget.sessionUsed + cost > context.budget.sessionLimit) return false;
      if (context.budget.dailyLimit && context.budget.dailyUsed + cost > context.budget.dailyLimit) return false;
      return true;
    });

    const pool = withinBudget.length > 0 ? withinBudget : sorted;
    const selected = pool[0];
    const fallbacks = pool.slice(1, 4);

    return {
      model: selected,
      fallbacks,
      reason: `Quality-first: best model (${selected.name}, tier ${selected.capabilities.qualityTier}) for ${task.type}`,
      estimatedCost: estimateCost(selected, task),
      strategy: 'quality-first',
    };
  },
};

function estimateCost(model: ModelEntry, task: TaskProfile): number {
  const { input, output } = task.estimatedTokens;
  return (
    (input / 1_000_000) * model.pricing.inputPer1MTokens +
    (output / 1_000_000) * model.pricing.outputPer1MTokens
  );
}
