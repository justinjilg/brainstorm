/**
 * Risk classification — pure helper extracted from ChangeSetCard for
 * unit-testability without React.
 *
 * Bucket thresholds match the cli's CLI risk-level semantics in
 * docs/platform-contract-v1.md §3:
 *   read_only/low → 0-29
 *   medium        → 30-59
 *   high          → 60-79
 *   critical      → 80-100
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

export function riskLevelOf(score: number): RiskLevel {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}
