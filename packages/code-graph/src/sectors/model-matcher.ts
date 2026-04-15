/**
 * Model Matcher — maps sector tiers to BR Complexity + QualityTier.
 *
 * No hardcoded model names. The router's existing `auto` strategy
 * maps QualityTier to the best available model at that tier.
 * Sector agents create a TaskProfile with their sector's complexity,
 * and BrainstormRouter handles actual model selection.
 */

import type { SectorTier } from "../community/sector-profile.js";
import {
  TIER_TO_COMPLEXITY,
  TIER_TO_QUALITY,
} from "../community/sector-profile.js";

export interface SectorTaskProfile {
  /** BR Complexity type for this sector's work. */
  complexity: string;
  /** BR QualityTier (1=best, 5=cheapest). */
  qualityTier: number;
  /** Whether tasks in this sector typically require reasoning. */
  requiresReasoning: boolean;
  /** Whether tasks typically require tool use. */
  requiresToolUse: boolean;
  /** Suggested max steps for sector agent. */
  maxSteps: number;
  /** Per-tick budget suggestion in USD. */
  budgetPerTick: number;
}

/**
 * Build a TaskProfile-compatible config from a sector tier.
 * Passed to BrainstormRouter.route() for model selection.
 */
export function profileForTier(tier: SectorTier): SectorTaskProfile {
  return {
    complexity: TIER_TO_COMPLEXITY[tier],
    qualityTier: TIER_TO_QUALITY[tier],
    requiresReasoning: tier === "critical" || tier === "complex",
    requiresToolUse: true,
    maxSteps: tier === "critical" ? 15 : tier === "complex" ? 10 : 5,
    budgetPerTick:
      tier === "critical"
        ? 0.1
        : tier === "complex"
          ? 0.05
          : tier === "standard"
            ? 0.02
            : 0.01,
  };
}
