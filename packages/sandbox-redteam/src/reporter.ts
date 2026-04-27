// JSON serializer for RedTeamReport. Pinned to schema_version "1.0".
// The report shape is documented in the package README.

import type { RedTeamReport, ValidationStatus } from "./types.js";

export function serializeReport(report: RedTeamReport): string {
  return JSON.stringify(report, null, 2);
}

/** Quick sanity-check used in tests and the CLI exit code. */
export function reportIsClean(report: RedTeamReport): boolean {
  return (
    report.summary.failed === 0 &&
    report.summary.errored === 0 &&
    report.final_sandbox_state !== "failed"
  );
}

/**
 * Per-validation-status counts. Operators read this to know how much of
 * the report was real-CHV-validated vs still mock substrate. The CLI
 * surfaces the same numbers in stderr; the report's notes section
 * embeds them so the JSON itself is self-describing.
 */
export interface ValidationProvenanceSummary {
  total: number;
  mockOnly: number;
  validatedChv: number;
  validatedVf: number;
  validatedChvAndVf: number;
}

export function summariseValidationProvenance(
  report: RedTeamReport,
): ValidationProvenanceSummary {
  const counts: Record<ValidationStatus, number> = {
    "mock-only": 0,
    "validated-chv": 0,
    "validated-vf": 0,
    "validated-chv-and-vf": 0,
  };
  for (const probe of report.probes) {
    counts[probe.validated_against] =
      (counts[probe.validated_against] ?? 0) + 1;
  }
  return {
    total: report.probes.length,
    mockOnly: counts["mock-only"],
    validatedChv: counts["validated-chv"],
    validatedVf: counts["validated-vf"],
    validatedChvAndVf: counts["validated-chv-and-vf"],
  };
}
