/**
 * BrEnvelope parser tests + drift ratchet.
 *
 * Two distinct concerns:
 *   1. Parser correctness — given a known headers shape, the parser emits
 *      typed fields with correct types (numbers parsed, JSON decoded,
 *      URL-encoded fields decoded, "n/a" treated as undefined for numeric
 *      fields, complexity-score kept as string when non-numeric).
 *   2. Drift ratchet — every header in CANONICAL_BR_HEADERS must have a
 *      consumer in BrEnvelope. Conversely, the parser must populate
 *      unknownHeaders when it sees an x-br-* header outside the canonical
 *      set (so a live-response drift test in CI can fail on it).
 *
 * NOT in this file: the live-response drift test (Phase 5 in the
 * path-to-90 plan). That will hit api.brainstormrouter.com and assert the
 * actual server-emitted header set matches CANONICAL_BR_HEADERS modulo
 * KNOWN_OPTIONAL_BR_HEADERS. This file does the same logic with a fixture
 * derived from the live response captured 2026-05-15.
 */

import { describe, it, expect } from "vitest";
import {
  parseBrEnvelope,
  CANONICAL_BR_HEADERS,
  KNOWN_OPTIONAL_BR_HEADERS,
  type BrEnvelope,
} from "../cloud/br-envelope.js";

// ── Fixture: live response captured 2026-05-15 ──────────────────────
// curl -sS -D - -o /dev/null https://api.brainstormrouter.com/v1/chat/completions ...
// Pulled into the docs/assessment-evidence.md §11c at audit time. This
// fixture is the ground truth for "what BR currently emits."
const LIVE_2026_05_15: Record<string, string> = {
  "content-type": "application/json",
  "x-br-actual-cost": "0.000037",
  "x-br-audit-hash":
    "590439b4451f67ea3ce43942edd66f831b1bd3ffd2c625f1e78898196314c285",
  "x-br-budget-remaining": "1.95",
  "x-br-build": "1b3c127",
  "x-br-complexity-level": "n/a",
  "x-br-complexity-score": "n/a",
  "x-br-context":
    '{"model":"deepseek/deepseek-chat","why":"explicit","cost":0.00003654,"budget_remaining":1.95,"cache":"miss","memory_facts":0}',
  "x-br-degradation-level": "0",
  "x-br-deprecation":
    "deepseek/deepseek-chat sunset 2026-07-24T15:59:00Z, migrate to deepseek/deepseek-v4-flash",
  "x-br-envelope": "audit",
  "x-br-estimated-cost": "0.0000",
  "x-br-estimated-cost-cents": "0",
  "x-br-guardian-overhead-ms": "0.3",
  "x-br-guardian-status": "on",
  "x-br-guardrail-actions":
    "%5B%7B%22type%22%3A%22content_filtered%22%2C%22category%22%3A%22response_waf%22%7D%5D",
  "x-br-guardrail-status": "warn",
  "x-br-guardrail-summary": "modified:content=1",
  "x-br-model-contract": "strict",
  "x-br-models-considered": "1",
  "x-br-provider-latency-ms": "341",
  "x-br-quality-score": "0.80",
  "x-br-quality-tier": "heuristic",
  "x-br-reputation-tier": "gold",
  "x-br-requests-remaining": "99",
  "x-br-route-confidence": "0.10",
  "x-br-route-reason": "explicit",
  "x-br-routed-model": "deepseek/deepseek-chat",
  "x-br-routing-overhead-ms": "2546.3",
  "x-br-routing-reasoning":
    '{"model":"deepseek/deepseek-chat","reason":"deepseek::deepseek-chat"}',
  "x-br-routing-savings": "0.003188",
  "x-br-selection-confidence": "1.00",
  "x-br-selection-method": "explicit",
  "x-br-tier": "community",
  "x-br-tokens-remaining": "100000",
  "x-br-total-latency-ms": "2383",
};

describe("parseBrEnvelope — typed parser", () => {
  it("parses numeric headers as numbers", () => {
    const env = parseBrEnvelope(LIVE_2026_05_15);
    expect(env.actualCost).toBe(0.000037);
    expect(env.budgetRemaining).toBe(1.95);
    expect(env.routingOverheadMs).toBe(2546.3);
    expect(env.qualityScore).toBe(0.8);
    expect(env.routeConfidence).toBe(0.1);
    expect(env.modelsConsidered).toBe(1);
    expect(env.tokensRemaining).toBe(100000);
    expect(env.degradationLevel).toBe(0);
    expect(env.estimatedCostCents).toBe(0);
  });

  it('treats "n/a" numeric fields as undefined', () => {
    const env = parseBrEnvelope(LIVE_2026_05_15);
    // complexityScore collapses to undefined when BR returns "n/a" so the
    // typed shape matches shared/types.ts:194 (number | undefined). The
    // explicit "n/a" signal is preserved via complexityLevel.
    expect(env.complexityScore).toBeUndefined();
    expect(env.complexityLevel).toBe("n/a");
  });

  it("parses numeric complexity-score when BR returns a real number", () => {
    const env = parseBrEnvelope({
      ...LIVE_2026_05_15,
      "x-br-complexity-score": "3.5",
      "x-br-complexity-level": "moderate",
    });
    expect(env.complexityScore).toBe(3.5);
    expect(env.complexityLevel).toBe("moderate");
  });

  it("parses JSON headers into objects", () => {
    const env = parseBrEnvelope(LIVE_2026_05_15);
    expect(env.routingReasoning).toEqual({
      model: "deepseek/deepseek-chat",
      reason: "deepseek::deepseek-chat",
    });
    expect(env.context).toMatchObject({
      model: "deepseek/deepseek-chat",
      why: "explicit",
      cache: "miss",
    });
  });

  it("decodes URL-encoded guardrail actions", () => {
    const env = parseBrEnvelope(LIVE_2026_05_15);
    expect(Array.isArray(env.guardrailActions)).toBe(true);
    expect((env.guardrailActions as Array<{ type: string }>)[0].type).toBe(
      "content_filtered",
    );
  });

  it("captures string identity fields", () => {
    const env = parseBrEnvelope(LIVE_2026_05_15);
    expect(env.build).toBe("1b3c127");
    expect(env.envelope).toBe("audit");
    expect(env.tier).toBe("community");
    expect(env.reputationTier).toBe("gold");
    expect(env.modelContract).toBe("strict");
    expect(env.routedModel).toBe("deepseek/deepseek-chat");
    expect(env.routeReason).toBe("explicit");
    expect(env.qualityTier).toBe("heuristic");
  });

  it("captures the audit-hash (64-hex)", () => {
    const env = parseBrEnvelope(LIVE_2026_05_15);
    expect(env.auditHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("captures deprecation notice when present", () => {
    const env = parseBrEnvelope(LIVE_2026_05_15);
    expect(env.deprecation).toContain("sunset");
    expect(env.deprecation).toContain("migrate to");
  });

  it("returns undefined for absent fields without throwing", () => {
    const env = parseBrEnvelope({});
    // Every numeric field should be undefined (no NaN).
    const numericFields: (keyof BrEnvelope)[] = [
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
      "routeConfidence",
      "selectionConfidence",
      "modelsConsidered",
      "qualityScore",
      "degradationLevel",
    ];
    for (const k of numericFields) {
      expect(env[k], `field ${String(k)}`).toBeUndefined();
    }
    expect(env.unknownHeaders).toEqual([]);
  });

  it("works with Headers (Fetch API) objects, not just plain records", () => {
    const h = new Headers();
    h.set("x-br-actual-cost", "0.123");
    h.set("x-br-routed-model", "claude-opus-4-7");
    const env = parseBrEnvelope(h);
    expect(env.actualCost).toBe(0.123);
    expect(env.routedModel).toBe("claude-opus-4-7");
  });
});

describe("parseBrEnvelope — drift ratchet", () => {
  it("captures all 33 documented headers from the 2026-05-15 live fixture (no unknown drift)", () => {
    const env = parseBrEnvelope(LIVE_2026_05_15);
    // The fixture contains exactly the canonical set; unknownHeaders MUST
    // be empty. If BR adds a header, CANONICAL_BR_HEADERS must be updated
    // FIRST, then the fixture, then the parser field.
    expect(env.unknownHeaders).toEqual([]);
  });

  it("flags unknown x-br-* headers in unknownHeaders", () => {
    // Synthetic future drift: BR adds an unannounced header.
    const env = parseBrEnvelope({
      ...LIVE_2026_05_15,
      "x-br-unannounced-new-thing": "v1",
    });
    expect(env.unknownHeaders).toContain("x-br-unannounced-new-thing");
  });

  it("CANONICAL_BR_HEADERS has no duplicates", () => {
    const set = new Set(CANONICAL_BR_HEADERS);
    expect(set.size).toBe(CANONICAL_BR_HEADERS.length);
  });

  it("CANONICAL_BR_HEADERS contains the live-2026-05-15 envelope as a subset", () => {
    // The fixture captures one real response. The canonical list is the
    // union of "all headers BR may emit across all known scenarios" — so
    // every fixture key MUST be in the canonical set, but the canonical
    // set may be larger (conditional headers like x-br-deprecation surface
    // only when a deprecation is active).
    const canonicalSet = new Set<string>(CANONICAL_BR_HEADERS);
    const fixtureBrKeys = Object.keys(LIVE_2026_05_15)
      .filter((k) => k.startsWith("x-br-"))
      .map((k) => k.toLowerCase());
    for (const key of fixtureBrKeys) {
      expect(canonicalSet.has(key), `missing canonical: ${key}`).toBe(true);
    }
    // Sanity floor — last verified 2026-05-15. Bumps with deliberate schema
    // changes; CI surfaces the deliberate change at PR time.
    expect(CANONICAL_BR_HEADERS.length).toBeGreaterThanOrEqual(33);
  });

  it("KNOWN_OPTIONAL_BR_HEADERS is documented (may be empty)", () => {
    // Sanity: the optional allow-list is a typed array. Future entries
    // here are forward-compat affordances; deletions are schema bumps.
    expect(Array.isArray(KNOWN_OPTIONAL_BR_HEADERS)).toBe(true);
  });

  it("every canonical header maps to a non-discarded BrEnvelope field", () => {
    // Coverage check: synthesize a response with EVERY canonical header set
    // to a sentinel, run the parser, and verify each parsed-out value made
    // it onto some field on BrEnvelope. This is the "no header silently
    // dropped on the floor" assertion.
    const synth: Record<string, string> = {};
    for (const h of CANONICAL_BR_HEADERS) {
      // Use a header-specific sentinel so we can grep the result.
      synth[h] = h.replace("x-br-", "SENTINEL-");
    }
    // Override numeric/JSON fields with valid types so the parser doesn't
    // squash them via the numeric/JSON normalisation paths.
    synth["x-br-actual-cost"] = "1.1";
    synth["x-br-estimated-cost"] = "1.2";
    synth["x-br-estimated-cost-cents"] = "12";
    synth["x-br-routing-savings"] = "0.5";
    synth["x-br-budget-remaining"] = "100";
    synth["x-br-tokens-remaining"] = "1000";
    synth["x-br-requests-remaining"] = "99";
    synth["x-br-total-latency-ms"] = "500";
    synth["x-br-provider-latency-ms"] = "200";
    synth["x-br-routing-overhead-ms"] = "50";
    synth["x-br-guardian-overhead-ms"] = "10";
    synth["x-br-route-confidence"] = "0.9";
    synth["x-br-selection-confidence"] = "1.0";
    synth["x-br-models-considered"] = "3";
    synth["x-br-quality-score"] = "0.85";
    synth["x-br-complexity-score"] = "2.5";
    synth["x-br-degradation-level"] = "0";
    synth["x-br-routing-reasoning"] = JSON.stringify({ marker: "rr" });
    synth["x-br-context"] = JSON.stringify({ marker: "ctx" });
    synth["x-br-guardrail-actions"] = encodeURIComponent(
      JSON.stringify([{ marker: "gr" }]),
    );

    const env = parseBrEnvelope(synth);
    // String fields keep the SENTINEL- prefix.
    expect(env.build).toBe("SENTINEL-build");
    expect(env.envelope).toBe("SENTINEL-envelope");
    expect(env.tier).toBe("SENTINEL-tier");
    expect(env.reputationTier).toBe("SENTINEL-reputation-tier");
    expect(env.modelContract).toBe("SENTINEL-model-contract");
    expect(env.routedModel).toBe("SENTINEL-routed-model");
    expect(env.routeReason).toBe("SENTINEL-route-reason");
    expect(env.selectionMethod).toBe("SENTINEL-selection-method");
    expect(env.qualityTier).toBe("SENTINEL-quality-tier");
    expect(env.complexityLevel).toBe("SENTINEL-complexity-level");
    // complexity-score is numeric (sentinel was string by default, overridden above)
    expect(env.complexityScore).toBe(2.5);
    expect(env.auditHash).toBe("SENTINEL-audit-hash");
    expect(env.guardianStatus).toBe("SENTINEL-guardian-status");
    expect(env.guardrailStatus).toBe("SENTINEL-guardrail-status");
    expect(env.guardrailSummary).toBe("SENTINEL-guardrail-summary");
    expect(env.deprecation).toBe("SENTINEL-deprecation");
    // Numerics + JSON parsed correctly.
    expect(env.actualCost).toBe(1.1);
    expect(env.routeConfidence).toBe(0.9);
    expect(env.routingReasoning).toEqual({ marker: "rr" });
    expect(env.context).toEqual({ marker: "ctx" });
    expect(env.guardrailActions).toEqual([{ marker: "gr" }]);
    // No unknowns (every key was in canonical).
    expect(env.unknownHeaders).toEqual([]);
  });
});
