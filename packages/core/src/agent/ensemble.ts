/**
 * Ensemble Generation — multi-model diversity for hard tasks.
 *
 * For tasks classified as complex/expert, generate from 2-3 models in parallel
 * and pick the best result via voting or comparison. Simple tasks keep
 * single-model routing (cheap).
 *
 * BrainstormRouter advantage: we pick the optimal 3 models dynamically
 * from production data. Trae Agent hardcodes Claude + Gemini + o4-mini.
 *
 * Inspired by ByteDance Trae Agent's generation-pruning-selection pipeline.
 */

import type { ModelEntry, Complexity } from "@brainst0rm/shared";

export interface EnsembleCandidate {
  model: string;
  /** Provider family (e.g., "anthropic", "openai", "google"). */
  provider?: string;
  text: string;
  tokenCount: number;
  latencyMs: number;
  cost: number;
}

export interface EnsembleResult {
  winner: EnsembleCandidate;
  candidates: EnsembleCandidate[];
  strategy: EnsembleStrategy;
  reason: string;
  earlyTermination: boolean;
}

export type EnsembleStrategy = "shortest" | "vote" | "first-pass";

/** Complexity threshold for triggering ensemble generation. */
const ENSEMBLE_COMPLEXITIES: Set<Complexity> = new Set(["complex", "expert"]);

/**
 * Check if a task should use ensemble generation.
 */
export function shouldUseEnsemble(
  complexity: Complexity,
  ensembleEnabled: boolean,
): boolean {
  return ensembleEnabled && ENSEMBLE_COMPLEXITIES.has(complexity);
}

/**
 * Prune duplicate results by token-level similarity.
 * Uses Jaccard similarity on word tokens.
 */
export function pruneResults(
  candidates: EnsembleCandidate[],
  similarityThreshold = 0.85,
): EnsembleCandidate[] {
  if (candidates.length <= 1) return candidates;

  const unique: EnsembleCandidate[] = [candidates[0]];

  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isDuplicate = unique.some(
      (existing) =>
        jaccardSimilarity(existing.text, candidate.text) >= similarityThreshold,
    );
    if (!isDuplicate) {
      unique.push(candidate);
    }
  }

  return unique;
}

/**
 * Select the winning candidate from pruned results.
 */
export function selectWinner(
  candidates: EnsembleCandidate[],
  strategy: EnsembleStrategy = "shortest",
): EnsembleResult {
  if (candidates.length === 0) {
    throw new Error("No candidates to select from.");
  }

  if (candidates.length === 1) {
    return {
      winner: candidates[0],
      candidates,
      strategy,
      reason: "Only one candidate after pruning.",
      earlyTermination: true,
    };
  }

  let winner: EnsembleCandidate;
  let reason: string;

  switch (strategy) {
    case "shortest":
      // Prefer the shortest response (simpler = more likely correct for coding)
      winner = candidates.reduce((a, b) =>
        a.tokenCount <= b.tokenCount ? a : b,
      );
      reason = `Shortest response: ${winner.model} (${winner.tokenCount} tokens vs ${candidates.map((c) => c.tokenCount).join(", ")})`;
      break;

    case "first-pass":
      // First candidate wins (fastest model)
      winner = candidates[0];
      reason = `First response: ${winner.model} (${winner.latencyMs}ms)`;
      break;

    case "vote":
    default:
      // For voting, we'd need an LLM call — fall back to shortest for now
      // Full voting implementation would call a cheap model to judge
      winner = candidates.reduce((a, b) =>
        a.tokenCount <= b.tokenCount ? a : b,
      );
      reason = `Vote fallback (shortest): ${winner.model}`;
      break;
  }

  return {
    winner,
    candidates,
    strategy,
    reason,
    earlyTermination: false,
  };
}

/**
 * Check for early termination: if first 2 results are very similar,
 * skip the 3rd model call.
 */
export function checkEarlyTermination(
  candidatesSoFar: EnsembleCandidate[],
  similarityThreshold = 0.9,
): boolean {
  if (candidatesSoFar.length < 2) return false;

  const [a, b] = candidatesSoFar;
  return jaccardSimilarity(a.text, b.text) >= similarityThreshold;
}

/**
 * Format ensemble result for context injection.
 */
export function formatEnsembleResult(result: EnsembleResult): string {
  const candidateList = result.candidates
    .map((c) => `${c.model}(${c.tokenCount}tok, $${c.cost.toFixed(3)})`)
    .join(", ");

  return `[Ensemble: ${result.candidates.length} candidates (${candidateList}). Winner: ${result.winner.model}. ${result.reason}${result.earlyTermination ? " (early termination)" : ""}]`;
}

/**
 * Minimum number of distinct provider families required for ensemble.
 * Prevents the Sybil attack: if all candidates are from the same provider,
 * they share biases and blind spots, making the ensemble a monoculture.
 */
const MIN_PROVIDER_FAMILIES = 2;

/**
 * Check if a set of models has sufficient provider diversity for ensemble.
 * Returns the distinct provider families found.
 */
export function checkProviderDiversity(models: Array<{ provider: string }>): {
  diverse: boolean;
  families: string[];
  count: number;
} {
  const families = [...new Set(models.map((m) => m.provider.toLowerCase()))];
  return {
    diverse: families.length >= MIN_PROVIDER_FAMILIES,
    families,
    count: families.length,
  };
}

/**
 * Filter ensemble candidates to ensure provider diversity.
 * If all candidates are from one provider, returns a warning.
 */
export function ensureDiversity(candidates: EnsembleCandidate[]): {
  candidates: EnsembleCandidate[];
  warning?: string;
} {
  const withProvider = candidates.filter((c) => c.provider);
  if (withProvider.length === 0) return { candidates };

  const families = [
    ...new Set(withProvider.map((c) => c.provider!.toLowerCase())),
  ];

  if (families.length < MIN_PROVIDER_FAMILIES && candidates.length >= 2) {
    return {
      candidates,
      warning: `Ensemble has ${candidates.length} candidates but only ${families.length} provider family (${families.join(", ")}). Results may share systematic biases. Add models from different providers for true diversity.`,
    };
  }

  return { candidates };
}

/**
 * Jaccard similarity on word tokens.
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/));
  const tokensB = new Set(b.toLowerCase().split(/\s+/));

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
