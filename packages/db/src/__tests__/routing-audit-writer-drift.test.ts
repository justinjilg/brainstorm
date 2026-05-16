/**
 * Drift test for routing-audit-writer.
 *
 * Codex flagged on PR #324 that BrEnvelopeLike was missing 10 fields
 * the parser captures, with the audit row claiming to persist the
 * "full envelope" while silently dropping them. Fixed by:
 *
 *   (a) extending BrEnvelopeLike to 1:1 mirror BrEnvelope's field set
 *   (b) introducing PERSISTED_BR_ENVELOPE_FIELDS — the explicit subset
 *       the SQL schema currently carries columns for
 *   (c) introducing IGNORED_BR_ENVELOPE_FIELDS — every parsed field
 *       intentionally not persisted, each with a documented rationale
 *
 * This test asserts every BrEnvelope field appears in EXACTLY one of
 * (PERSISTED, IGNORED). A new parser field with no decision will fail
 * here at PR time instead of silently dropping audit data.
 */

import { describe, it, expect } from "vitest";
import {
  PERSISTED_BR_ENVELOPE_FIELDS,
  IGNORED_BR_ENVELOPE_FIELDS,
  type BrEnvelopeLike,
} from "../routing-audit-writer.js";

// Exhaustive list of every BrEnvelopeLike field. Maintained by hand
// because TypeScript erases interface shape at runtime — but the test
// fails loudly when this list drifts from PERSISTED ∪ IGNORED, and
// CI runs it on every PR that touches the type.
const ALL_BR_ENVELOPE_FIELDS: ReadonlyArray<keyof BrEnvelopeLike> = [
  "requestId",
  "build",
  "envelope",
  "tier",
  "reputationTier",
  "modelContract",
  "actualCost",
  "estimatedCost",
  "estimatedCostCents",
  "routingSavings",
  "budgetRemaining",
  "tokensRemaining",
  "requestsRemaining",
  "totalLatencyMs",
  "providerLatencyMs",
  "routingOverheadMs",
  "guardianOverheadMs",
  "routedModel",
  "routeReason",
  "routeConfidence",
  "routingReasoning",
  "selectionMethod",
  "selectionConfidence",
  "modelsConsidered",
  "qualityTier",
  "qualityScore",
  "complexityLevel",
  "complexityScore",
  "auditHash",
  "context",
  "guardianStatus",
  "guardrailStatus",
  "guardrailSummary",
  "guardrailActions",
  "degradationLevel",
  "deprecation",
  "cache",
  "cacheAge",
  "cacheSimilarity",
  "coldStartMs",
  "unknownHeaders",
];

describe("routing-audit-writer field-coverage drift", () => {
  it("every envelope field is either persisted or explicitly ignored", () => {
    const persisted = new Set<string>(PERSISTED_BR_ENVELOPE_FIELDS);
    const ignored = new Set<string>(Object.keys(IGNORED_BR_ENVELOPE_FIELDS));
    const uncategorised: string[] = [];
    for (const field of ALL_BR_ENVELOPE_FIELDS) {
      const inPersisted = persisted.has(field);
      const inIgnored = ignored.has(field);
      if (!inPersisted && !inIgnored) {
        uncategorised.push(field as string);
      }
      // Belt-and-braces: a field can't be both. If a future PR
      // tries to mark something both persisted and ignored, fail.
      expect(
        inPersisted && inIgnored,
        `Field "${field}" is in BOTH persisted and ignored sets`,
      ).toBe(false);
    }
    expect(
      uncategorised,
      `Envelope fields with no persistence decision: ${uncategorised.join(", ")}. ` +
        "Add to PERSISTED_BR_ENVELOPE_FIELDS (and the SQL schema) or " +
        "IGNORED_BR_ENVELOPE_FIELDS (with a one-line rationale).",
    ).toEqual([]);
  });

  it("every ignored field has a non-empty rationale", () => {
    for (const [field, reason] of Object.entries(IGNORED_BR_ENVELOPE_FIELDS)) {
      expect(reason, `IGNORED field "${field}" needs a rationale`).toBeTruthy();
      expect(
        reason.length,
        `IGNORED rationale for "${field}" too terse`,
      ).toBeGreaterThan(10);
    }
  });

  it("persisted-vs-ignored split adds up to total field count", () => {
    const total =
      PERSISTED_BR_ENVELOPE_FIELDS.length +
      Object.keys(IGNORED_BR_ENVELOPE_FIELDS).length;
    expect(total).toBe(ALL_BR_ENVELOPE_FIELDS.length);
  });

  it("no persisted field is duplicated", () => {
    const set = new Set(PERSISTED_BR_ENVELOPE_FIELDS);
    expect(set.size).toBe(PERSISTED_BR_ENVELOPE_FIELDS.length);
  });
});
