import type {
  TaskProfile,
  ModelEntry,
  RoutingContext,
  RoutingDecision,
  QualityTier,
} from "@brainst0rm/shared";
import type { RoutingStrategy } from "./types.js";

// Minimum quality tier required for each task type
const MIN_QUALITY: Record<string, QualityTier> = {
  "simple-edit": 5,
  "code-generation": 3,
  refactoring: 3,
  debugging: 2,
  explanation: 4,
  conversation: 5,
  analysis: 2,
  search: 5,
  "multi-file-edit": 2,
};

export const costFirstStrategy: RoutingStrategy = {
  name: "cost-first",

  select(
    task: TaskProfile,
    candidates: ModelEntry[],
    context: RoutingContext,
  ): RoutingDecision | null {
    const minQuality = MIN_QUALITY[task.type] ?? 3;

    // Filter to models that meet the quality threshold
    const eligible = candidates.filter(
      (m) =>
        m.status === "available" && m.capabilities.qualityTier <= minQuality,
    );
    if (eligible.length === 0) return null;

    // Sort by estimated cost (local models cost 0)
    const sorted = eligible.sort((a, b) => {
      const costA = estimateCost(a, task);
      const costB = estimateCost(b, task);
      return costA - costB;
    });

    const selected = sorted[0];
    const fallbacks = sorted.slice(1, 4);

    return {
      model: selected,
      fallbacks,
      reason: `Cost-first: cheapest model (${selected.name}) meeting quality tier ${minQuality} for ${task.type}`,
      estimatedCost: estimateCost(selected, task),
      strategy: "cost-first",
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
