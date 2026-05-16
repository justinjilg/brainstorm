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

// v16 Sr Engineer (PR #324 follow-up) flagged that the hand-maintained
// ALL_BR_ENVELOPE_FIELDS list could silently miss a new field added to
// BrEnvelopeLike. Fix: declare the list as a Required mapped type over
// keyof BrEnvelopeLike — TypeScript refuses to compile if any required
// key is missing. The runtime test then derives the array from
// Object.keys, so the *single source of truth* is the BrEnvelopeLike
// type itself, not a separately-maintained list.
const ALL_BR_ENVELOPE_FIELDS_MAP: Required<Record<keyof BrEnvelopeLike, true>> =
  {
    requestId: true,
    build: true,
    envelope: true,
    tier: true,
    reputationTier: true,
    modelContract: true,
    actualCost: true,
    estimatedCost: true,
    estimatedCostCents: true,
    routingSavings: true,
    budgetRemaining: true,
    tokensRemaining: true,
    requestsRemaining: true,
    totalLatencyMs: true,
    providerLatencyMs: true,
    routingOverheadMs: true,
    guardianOverheadMs: true,
    routedModel: true,
    routeReason: true,
    routeConfidence: true,
    routingReasoning: true,
    selectionMethod: true,
    selectionConfidence: true,
    modelsConsidered: true,
    qualityTier: true,
    qualityScore: true,
    complexityLevel: true,
    complexityScore: true,
    auditHash: true,
    context: true,
    guardianStatus: true,
    guardrailStatus: true,
    guardrailSummary: true,
    guardrailActions: true,
    degradationLevel: true,
    deprecation: true,
    cache: true,
    cacheAge: true,
    cacheSimilarity: true,
    coldStartMs: true,
    unknownHeaders: true,
  };
const ALL_BR_ENVELOPE_FIELDS: ReadonlyArray<keyof BrEnvelopeLike> = Object.keys(
  ALL_BR_ENVELOPE_FIELDS_MAP,
) as (keyof BrEnvelopeLike)[];

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
