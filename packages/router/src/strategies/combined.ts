import type {
  TaskProfile,
  ModelEntry,
  RoutingContext,
  RoutingDecision,
} from "@brainst0rm/shared";
import type { RoutingRule } from "@brainst0rm/config";
import type { RoutingStrategy } from "./types.js";
import { costFirstStrategy } from "./cost-first.js";
import { qualityFirstStrategy } from "./quality-first.js";
import { createRuleBasedStrategy } from "./rule-based.js";
import { learnedStrategy, getSamplesForTaskType } from "./learned.js";

/** Minimum samples before Thompson sampling is trusted for a task type. */
const LEARNED_THRESHOLD = 20;

export function createCombinedStrategy(rules: RoutingRule[]): RoutingStrategy {
  const ruleStrategy = createRuleBasedStrategy(rules);

  return {
    name: "combined",

    select(
      task: TaskProfile,
      candidates: ModelEntry[],
      context: RoutingContext,
    ): RoutingDecision | null {
      // 1. Try rule-based first
      const ruleResult = ruleStrategy.select(task, candidates, context);
      if (ruleResult) return ruleResult;

      // 2. Budget pressure check — if >80% daily budget spent, cost must dominate.
      //    Thompson sampling optimizes for success rate, not cost. Under pressure,
      //    we skip learned and fall through to cost-first for simple or trivial tasks.
      const budgetPressure = context.budget.dailyLimit
        ? context.budget.dailyUsed / context.budget.dailyLimit
        : 0;

      // 3. If Thompson sampling has enough data and budget allows, use learned strategy.
      //    This is the key integration: once BR has seen enough outcomes, it stops
      //    relying on hardcoded tiers and starts routing based on actual performance.
      if (budgetPressure < 0.8) {
        const samplesForTask = getSamplesForTaskType(task.type);
        if (samplesForTask >= LEARNED_THRESHOLD) {
          const learnedResult = learnedStrategy.select(
            task,
            candidates,
            context,
          );
          if (learnedResult) {
            learnedResult.reason = `Learned (${samplesForTask} samples): ${learnedResult.reason}`;
            return learnedResult;
          }
        }
      }

      // 4. Trivial/simple tasks → cost-first (use local/cheap models)
      if (task.complexity === "trivial" || task.complexity === "simple") {
        return costFirstStrategy.select(task, candidates, context);
      }

      // 5. Complex/expert tasks → quality-first (use the best available)
      if (task.complexity === "complex" || task.complexity === "expert") {
        return qualityFirstStrategy.select(task, candidates, context);
      }

      // 6. Moderate tasks → weighted scoring
      return weightedSelect(task, candidates, context);
    },
  };
}

function weightedSelect(
  task: TaskProfile,
  candidates: ModelEntry[],
  context: RoutingContext,
): RoutingDecision | null {
  const available = candidates.filter((m) => m.status === "available");
  if (available.length === 0) return null;

  const scored = available.map((model) => {
    // Quality score: lower tier = better (1-5 → 1.0-0.2)
    const qualityScore = (6 - model.capabilities.qualityTier) / 5;

    // Cost score: cheaper = better (normalized against max cost)
    const cost = estimateCost(model, task);
    const maxCost = Math.max(
      ...available.map((m) => estimateCost(m, task)),
      0.001,
    );
    const costScore = 1 - cost / maxCost;

    // Speed score: lower tier = faster (1-5 → 1.0-0.2)
    const speedScore = (6 - model.capabilities.speedTier) / 5;

    // Bonus for models that list this task type in their bestFor
    const affinityBonus = model.capabilities.bestFor.includes(task.type)
      ? 0.15
      : 0;

    const totalScore =
      0.4 * qualityScore + 0.35 * costScore + 0.15 * speedScore + affinityBonus;

    return { model, score: totalScore, cost };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  return {
    model: best.model,
    fallbacks: scored.slice(1, 4).map((s) => s.model),
    reason: `Combined: weighted score selected ${best.model.name} (score: ${best.score.toFixed(3)}) for ${task.type}/${task.complexity}`,
    estimatedCost: best.cost,
    strategy: "combined",
  };
}

function estimateCost(model: ModelEntry, task: TaskProfile): number {
  const { input, output } = task.estimatedTokens;
  return (
    (input / 1_000_000) * model.pricing.inputPer1MTokens +
    (output / 1_000_000) * model.pricing.outputPer1MTokens
  );
}
