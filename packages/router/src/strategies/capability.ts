import type {
  TaskProfile,
  ModelEntry,
  RoutingContext,
  RoutingDecision,
  CapabilityScores,
} from "@brainst0rm/shared";
import type { RoutingStrategy } from "./types.js";

/**
 * Map task properties to the capability dimensions that matter most.
 * Returns weights for each dimension (0 = irrelevant, 1 = critical).
 */
function getRequiredCapabilities(
  task: TaskProfile,
): Partial<Record<keyof CapabilityScores, number>> {
  const caps: Partial<Record<keyof CapabilityScores, number>> = {};

  // Tool-heavy tasks need tool selection and sequencing
  if (task.requiresToolUse) {
    caps.toolSelection = 1.0;
    caps.toolSequencing = 0.8;
  }

  // Reasoning tasks need multi-step and self-correction
  if (task.requiresReasoning) {
    caps.multiStepReasoning = 1.0;
    caps.selfCorrection = 0.6;
  }

  // Code tasks need code generation
  if (
    [
      "code-generation",
      "refactoring",
      "multi-file-edit",
      "simple-edit",
    ].includes(task.type)
  ) {
    caps.codeGeneration = 1.0;
  }

  // Complex tasks need instruction following
  if (["complex", "expert"].includes(task.complexity)) {
    caps.instructionFollowing = 0.8;
    caps.multiStepReasoning = Math.max(caps.multiStepReasoning ?? 0, 0.8);
  }

  // Analysis/explanation need context utilization
  if (["analysis", "explanation", "debugging"].includes(task.type)) {
    caps.contextUtilization = 0.8;
  }

  // Search tasks primarily need context
  if (task.type === "search") {
    caps.contextUtilization = 1.0;
    caps.toolSelection = 0.8;
  }

  return caps;
}

/**
 * Score a model against required capabilities.
 * Returns a weighted sum of the model's capability scores for relevant dimensions.
 */
function scoreModel(
  model: ModelEntry,
  requirements: Partial<Record<keyof CapabilityScores, number>>,
): number {
  const scores = model.capabilities.capabilityScores;

  // Models without eval data: derive score from qualityTier (1=best → 0.9, 2 → 0.7, 3 → 0.5)
  // This prevents brainstormrouter/auto (qualityTier 1, $0 cost) from always winning the
  // tiebreaker — explicit models with known capabilities should be preferred.
  if (!scores) {
    const tier = model.capabilities.qualityTier ?? 3;
    return tier === 1 ? 0.9 : tier === 2 ? 0.7 : 0.5;
  }

  let totalScore = 0;
  let totalWeight = 0;

  for (const [dim, weight] of Object.entries(requirements)) {
    const modelScore = scores[dim as keyof CapabilityScores] ?? 0.5;
    totalScore += modelScore * weight;
    totalWeight += weight;
  }

  const base = totalWeight > 0 ? totalScore / totalWeight : 0.5;

  // Measured scores get a small confidence boost (+0.05) so the router prefers
  // evidence over assumption. Without this, assumed-optimistic static scores
  // (0.88-0.97 range) beat measured-honest scores (which often land in the
  // 0.4-0.7 range for hard probes), making every eval a routing regression.
  const isMeasured = (model.capabilities as any).scoresAreMeasured === true;
  return isMeasured ? Math.min(1.0, base + 0.05) : base;
}

function estimateCost(model: ModelEntry, task: TaskProfile): number {
  const { input, output } = task.estimatedTokens;
  return (
    (input / 1_000_000) * model.pricing.inputPer1MTokens +
    (output / 1_000_000) * model.pricing.outputPer1MTokens
  );
}

/**
 * Capability-aware routing strategy.
 *
 * Matches task requirements to model capability scores.
 * Picks the model with the highest capability match that fits within
 * budget constraints. Cost is used as a tiebreaker, not a primary factor.
 */
export const capabilityStrategy: RoutingStrategy = {
  name: "capability",

  select(
    task: TaskProfile,
    candidates: ModelEntry[],
    context: RoutingContext,
  ): RoutingDecision | null {
    let available = candidates.filter((m) => m.status === "available");
    if (available.length === 0) return null;

    // Prefer explicit models over brainstormrouter/auto.
    // Auto is a black box — we can't predict or control what model it picks.
    // Keep auto only as a last resort when no explicit models are available.
    if (available.length > 1) {
      const explicit = available.filter(
        (m) => m.id !== "brainstormrouter/auto",
      );
      if (explicit.length > 0) available = explicit;
    }

    // Honest data wins: if ANY candidate has measured eval scores, prefer
    // measured models over assumed ones. This prevents optimistic static
    // scores (0.88-0.97 range, assigned by humans) from beating real
    // measured scores (often 0.4-0.7 because probes are hard).
    //
    // The old behavior rewarded models that were never evaluated — they kept
    // their assumed scores while evaluated models got their real (lower)
    // numbers and lost the ranking. Rule of honest routing: data > guesses.
    const measured = available.filter(
      (m) => (m.capabilities as any).scoresAreMeasured === true,
    );
    if (measured.length > 0) {
      available = measured;
    }

    const requirements = getRequiredCapabilities(task);

    // Score each model against requirements
    const scored = available.map((model) => ({
      model,
      capabilityScore: scoreModel(model, requirements),
      cost: estimateCost(model, task),
    }));

    // Sort: highest capability score first, then cheapest as tiebreaker
    scored.sort((a, b) => {
      const scoreDiff = b.capabilityScore - a.capabilityScore;
      if (Math.abs(scoreDiff) > 0.05) return scoreDiff; // meaningful difference
      return a.cost - b.cost; // tiebreak on cost
    });

    const best = scored[0];
    const fallbacks = scored.slice(1, 4).map((s) => s.model);

    const reqDims = Object.keys(requirements).join(", ");

    return {
      model: best.model,
      fallbacks,
      reason: `Capability-aware: ${best.model.name} scored ${(best.capabilityScore * 100).toFixed(0)}% on [${reqDims}]`,
      estimatedCost: best.cost,
      strategy: "capability",
    };
  },
};
