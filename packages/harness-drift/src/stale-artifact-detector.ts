import { createHash } from "node:crypto";
import type { HarnessIndexStore } from "@brainst0rm/harness-index";
import type { Drift, DriftDetector, DriftSeverity } from "./types.js";

/**
 * Stale-artifact watchdog — emits observation-class drifts for indexed
 * artifacts whose `reviewed_at` field is past the configured freshness
 * SLA for their kind.
 *
 * Per spec `## Index Coherence and Drift Architecture` cross-cutting
 * concept: "Reviewed-at: every artifact has a last-reviewed timestamp.
 * Stale artifacts get flagged by an AI auditor."
 *
 * Per Decision #9 revised: this detector emits `field_class = "observation"`
 * — runtime is authoritative. The "observation" here is "the audit cadence
 * passed without review"; the file is wrong-by-policy if it's older than
 * the SLA. Reconciliation is "review the artifact and update reviewed_at"
 * (an indirect action — the user actually reads the file, decides it's
 * still right, and saves with a fresh timestamp).
 *
 * Default SLAs (overridable per kind):
 *   - decision      : 365 days   (decisions rarely revisit)
 *   - contract      : 90 days    (contracts review quarterly)
 *   - account       : 30 days    (accounts move fast)
 *   - product       : 90 days
 *   - human         : 180 days   (people don't change shape often)
 *   - agent         : 90 days
 *   - party         : 180 days
 *   - policy        : 180 days
 *   - okr           : 30 days    (OKRs are quarter-bound)
 *   - manifest      : 30 days
 *   - other         : 365 days
 */

const DEFAULT_SLAS_DAYS: Record<string, number> = {
  decision: 365,
  contract: 90,
  account: 30,
  product: 90,
  human: 180,
  agent: 90,
  party: 180,
  policy: 180,
  okr: 30,
  manifest: 30,
  other: 365,
};

export interface StaleArtifactDetectorOptions {
  /** Override default SLAs by artifact_kind. Days. */
  slasDays?: Partial<Record<string, number>>;
  /** Override the default kind→severity mapping. Decisions defaulting to
   *  `informational`; contracts/account to `medium`; etc. */
  severityFor?: (kind: string, ageDays: number) => DriftSeverity;
  /** Optional clock injection for tests. */
  now?: () => number;
}

export class StaleArtifactDetector implements DriftDetector {
  readonly name = "stale-artifact-watchdog";
  readonly field_class = "observation" as const;

  private readonly slas: Record<string, number>;
  private readonly severityFn: (kind: string, ageDays: number) => DriftSeverity;
  private readonly now: () => number;

  constructor(
    private readonly index: HarnessIndexStore,
    options: StaleArtifactDetectorOptions = {},
  ) {
    // Cast: spread of Partial<Record<...>> may emit `undefined` per key in
    // exactOptionalPropertyTypes mode; we know the merge with DEFAULT_SLAS_DAYS
    // produces all-defined values for known keys.
    this.slas = {
      ...DEFAULT_SLAS_DAYS,
      ...(options.slasDays ?? {}),
    } as Record<string, number>;
    this.severityFn = options.severityFor ?? defaultSeverity;
    this.now = options.now ?? Date.now;
  }

  detect(): Drift[] {
    const now = this.now();
    const drifts: Drift[] = [];
    // Look at every artifact; check its kind's SLA.
    for (const row of this.index.allArtifacts()) {
      const kind = row.artifact_kind ?? "other";
      const slaDays = this.slas[kind] ?? this.slas.other!;
      const slaMs = slaDays * 24 * 60 * 60 * 1000;

      // Two stale modes:
      //   - reviewed_at is null AND artifact older than SLA       → "never reviewed"
      //   - reviewed_at is set AND now - reviewed_at > slaMs       → "review-overdue"
      const reviewedAt = row.reviewed_at ?? null;
      let isStale = false;
      let summary: "never-reviewed" | "review-overdue" = "review-overdue";
      let ageMs = 0;

      if (reviewedAt === null) {
        // Use indexed_at as a fallback (when was the artifact first observed).
        ageMs = now - row.indexed_at;
        if (ageMs > slaMs) {
          isStale = true;
          summary = "never-reviewed";
        }
      } else {
        ageMs = now - reviewedAt;
        if (ageMs > slaMs) {
          isStale = true;
          summary = "review-overdue";
        }
      }

      if (!isStale) continue;
      const ageDays = Math.floor(ageMs / 86_400_000);
      const overdueDays = Math.max(0, ageDays - slaDays);

      drifts.push({
        id: stableDriftId(this.name, row.relative_path, summary),
        field_class: "observation",
        relative_path: row.relative_path,
        field_path: "reviewed_at",
        intent_value:
          reviewedAt === null ? null : new Date(reviewedAt).toISOString(),
        observed_value: `${ageDays} days since ${summary === "never-reviewed" ? "first index" : "last review"} (SLA ${slaDays}d for ${kind}; overdue by ${overdueDays}d)`,
        detector_name: this.name,
        detected_at: now,
        severity: this.severityFn(kind, overdueDays),
      });
    }

    return drifts;
  }
}

/**
 * Severity from kind + days-overdue (NOT days-old).
 *
 * Severity grows with the *amount* the SLA is breached. The kind's
 * sensitivity weights how dangerous breaching is — contracts/accounts
 * are risky to leave stale; policies/decisions less so.
 */
function defaultSeverity(kind: string, overdueDays: number): DriftSeverity {
  const kindSensitivity = {
    contract: 2,
    account: 2,
    okr: 2,
    manifest: 2,
    product: 1,
    agent: 1,
    party: 1,
    human: 1,
    policy: 0,
    decision: 0,
    other: 0,
  } as const;

  const sensitivity = (kindSensitivity as Record<string, number>)[kind] ?? 0;
  // High-sensitivity kinds escalate fast: medium at 1+ day overdue,
  // high at 30+ days overdue.
  if (sensitivity >= 2 && overdueDays >= 30) return "high";
  if (sensitivity >= 2 && overdueDays >= 1) return "medium";
  // Mid-sensitivity: medium at 30+ overdue, high at 180+
  if (sensitivity >= 1 && overdueDays >= 180) return "high";
  if (sensitivity >= 1 && overdueDays >= 30) return "medium";
  // Low-sensitivity (policies/decisions): only escalate after 90+ overdue
  if (overdueDays >= 90) return "medium";
  return "low";
}

function stableDriftId(...parts: string[]): string {
  return (
    "drift_" +
    createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)
  );
}
