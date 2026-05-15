/**
 * BrEnvelope — typed parser for BrainstormRouter's `x-br-*` response headers.
 *
 * BR emits ~33 unique headers on every authenticated request (verified live
 * 2026-05-15 against api.brainstormrouter.com 1.0.0-beta.1 build 1b3c127).
 * Before this module landed, the SaaS provider in `brainstorm-saas.ts` was
 * receiving the full envelope and discarding it — every routing/cost/quality/
 * deprecation/audit signal BR emitted was lost to the consumer.
 *
 * Goal: parse the envelope into a typed `BrEnvelope` shape; expose it via a
 * caller-supplied callback the SaaS provider invokes per response; and ship
 * with a ratchet test that fails when BR adds a header we don't recognise OR
 * when the live response is missing one of our canonical headers (drift
 * detection in both directions).
 *
 * Headers grouped by concern:
 *   IDENTITY: build, envelope, tier, reputation-tier, model-contract
 *   COST:     actual-cost, estimated-cost, estimated-cost-cents, routing-savings
 *   BUDGET:   budget-remaining, tokens-remaining, requests-remaining
 *   LATENCY:  total-latency-ms, provider-latency-ms, routing-overhead-ms,
 *             guardian-overhead-ms
 *   ROUTING:  routed-model, route-reason, route-confidence, routing-reasoning,
 *             selection-method, selection-confidence, models-considered,
 *             quality-tier, quality-score
 *   TASK:     complexity-level, complexity-score
 *   AUDIT:    audit-hash, context
 *   GUARDIAN: guardian-status, guardrail-status, guardrail-summary, guardrail-actions
 *   LIFECYCLE:degradation-level, deprecation (conditional)
 *
 * See docs/brainstormrouter-integration.md for the canonical table and the
 * trust-envelope contract reference.
 */

// ── Canonical header set ────────────────────────────────────────────
//
// These are the `x-br-*` headers BR is currently known to emit on
// successful `/v1/chat/completions` responses. The ratchet test in
// `__tests__/br-envelope.test.ts` asserts:
//
//   (a) every header in this list is a field on BrEnvelope (no unparsed
//       canonical header), and
//   (b) a live response's `x-br-*` headers are a subset of this list,
//       modulo a small explicit allow-list of optional headers that BR
//       may add without breaking us (forward compatibility).
//
// Adding a new header here is a documented schema bump; deleting one
// requires a v15 assessment cite.
export const CANONICAL_BR_HEADERS = [
  // IDENTITY
  "x-br-build",
  "x-br-envelope",
  "x-br-tier",
  "x-br-reputation-tier",
  "x-br-model-contract",
  // COST
  "x-br-actual-cost",
  "x-br-estimated-cost",
  "x-br-estimated-cost-cents",
  "x-br-routing-savings",
  // BUDGET
  "x-br-budget-remaining",
  "x-br-tokens-remaining",
  "x-br-requests-remaining",
  // LATENCY
  "x-br-total-latency-ms",
  "x-br-provider-latency-ms",
  "x-br-routing-overhead-ms",
  "x-br-guardian-overhead-ms",
  // ROUTING
  "x-br-routed-model",
  "x-br-route-reason",
  "x-br-route-confidence",
  "x-br-routing-reasoning",
  "x-br-selection-method",
  "x-br-selection-confidence",
  "x-br-models-considered",
  "x-br-quality-tier",
  "x-br-quality-score",
  // TASK
  "x-br-complexity-level",
  "x-br-complexity-score",
  // AUDIT
  "x-br-audit-hash",
  "x-br-context",
  // GUARDIAN / GUARDRAILS
  "x-br-guardian-status",
  "x-br-guardrail-status",
  "x-br-guardrail-summary",
  "x-br-guardrail-actions",
  // LIFECYCLE (conditional but documented)
  "x-br-degradation-level",
  "x-br-deprecation",
  // CACHE (added 2026-05-15 by live ratchet detection on first run —
  // these headers were not in the 2026-05-15 documentation fixture but
  // ARE in live responses. The contract test caught them on first PR;
  // canonicalising here keeps the schema honest.)
  "x-br-cache",
  "x-br-cache-age",
  "x-br-cache-similarity",
  "x-br-cold-start-ms",
] as const;

export type CanonicalBrHeader = (typeof CANONICAL_BR_HEADERS)[number];

// Headers BR may emit that we don't capture by design (forward-compat
// allow-list). Update when BR adds a header we intentionally ignore.
export const KNOWN_OPTIONAL_BR_HEADERS: readonly string[] = [];

// ── Parsed envelope shape ───────────────────────────────────────────

export interface BrEnvelope {
  /** BR build SHA (short). Surfaces in error reports for cross-referencing. */
  build?: string;
  /** Envelope mode marker. "audit" today; "enforce" in future. */
  envelope?: string;
  /** Caller subscription tier (community, paid, enterprise). */
  tier?: string;
  /** Caller reputation tier (gold/silver/bronze/restricted). */
  reputationTier?: string;
  /** "strict" when model-contract enforcement is on. */
  modelContract?: string;

  /** Measured request cost in USD. */
  actualCost?: number;
  /** Pre-routing cost estimate in USD. */
  estimatedCost?: number;
  /** Pre-routing cost estimate in cents (integer). */
  estimatedCostCents?: number;
  /** Savings vs naive routing, USD. */
  routingSavings?: number;

  /** Budget remaining after this call, USD. */
  budgetRemaining?: number;
  /** Tokens remaining in budget window. */
  tokensRemaining?: number;
  /** Requests remaining in budget window. */
  requestsRemaining?: number;

  /** End-to-end latency in ms. */
  totalLatencyMs?: number;
  /** Provider-side latency only. */
  providerLatencyMs?: number;
  /** Time spent in BR routing logic. */
  routingOverheadMs?: number;
  /** Time spent in Guardian safety pass. */
  guardianOverheadMs?: number;

  /** Actual model BR routed to (e.g. "deepseek/deepseek-chat"). */
  routedModel?: string;
  /** Why this model was picked ("explicit", "auto", "preset", etc.). */
  routeReason?: string;
  /** Routing confidence (0–1). */
  routeConfidence?: number;
  /** Full reasoning JSON. Parsed if valid JSON; raw string otherwise. */
  routingReasoning?: unknown;
  /** Selection algorithm used. */
  selectionMethod?: string;
  /** Selection algorithm confidence (0–1). */
  selectionConfidence?: number;
  /** How many models BR evaluated. */
  modelsConsidered?: number;
  /** "heuristic" / "learned" / "verified". */
  qualityTier?: string;
  /** Quality score for the selected model (0–1). */
  qualityScore?: number;

  /** Task complexity bucket (simple/moderate/complex), or "n/a". Carries
   *  the "the classifier returned 'n/a'" signal explicitly, since the numeric
   *  score collapses to undefined in that case. */
  complexityLevel?: string;
  /** Numeric complexity score (BR returns numeric or literal "n/a"). The
   *  "n/a" value collapses to undefined here so downstream consumers can
   *  use a single numeric type matching the shared TaskProfile contract
   *  (packages/shared/src/types.ts:194). Check `complexityLevel === "n/a"`
   *  to distinguish "missing" from "explicitly not applicable". */
  complexityScore?: number;

  /** 64-hex audit-chain pointer for evidence-ledger linking. */
  auditHash?: string;
  /** Context blob (model/why/cost/cache/memory_facts). Parsed if JSON. */
  context?: unknown;

  /** Guardian safety pass: "on" / "off". */
  guardianStatus?: string;
  /** Response WAF state: "warn" / "enforce" / "off". */
  guardrailStatus?: string;
  /** Compact human summary of guardrail action. */
  guardrailSummary?: string;
  /** Guardrail action detail (URL-encoded JSON). Decoded + parsed if valid. */
  guardrailActions?: unknown;

  /** BR degradation level (0 nominal, >0 degraded). */
  degradationLevel?: number;
  /** Sunset notice for the routed model. Free-text including migrate-to. */
  deprecation?: string;

  /** Cache state for this request: "hit" / "miss" / "skip" / etc. */
  cache?: string;
  /** Age of the cached result in ms when cache=hit. */
  cacheAge?: number;
  /** Semantic similarity (0-1) between the request and the cached entry. */
  cacheSimilarity?: number;
  /** Cold-start time in ms when the worker had to spin up. */
  coldStartMs?: number;

  /** Headers seen on the response that are NOT in CANONICAL_BR_HEADERS or
   *  KNOWN_OPTIONAL_BR_HEADERS. Populated by the parser; the ratchet test
   *  fails on non-empty. Drives drift detection. */
  unknownHeaders: string[];
}

// ── Parser ──────────────────────────────────────────────────────────

function num(value: string | null | undefined): number | undefined {
  if (value == null || value === "" || value === "n/a") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function tryJson(value: string | null | undefined): unknown {
  if (value == null || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function tryDecodeJson(value: string | null | undefined): unknown {
  if (value == null || value === "") return undefined;
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return value;
  }
}

/**
 * Parse BR `x-br-*` headers from a Response (or headers-like object) into a
 * typed BrEnvelope. Missing fields are left undefined; unknown `x-br-*`
 * headers are collected into `unknownHeaders` for the ratchet test.
 *
 * Accepts any object whose entries iterate as [key, value] (Headers,
 * `headers` from fetch responses, or plain Record<string, string>). Header
 * lookups are case-insensitive on real `Headers`; plain records are
 * lower-cased before lookup.
 */
export function parseBrEnvelope(
  source: Headers | Record<string, string>,
): BrEnvelope {
  // Normalize to a case-insensitive getter + an iterable of known keys.
  const get =
    source instanceof Headers
      ? (k: string) => source.get(k)
      : (k: string) => {
          const lower = k.toLowerCase();
          for (const [hk, hv] of Object.entries(source)) {
            if (hk.toLowerCase() === lower) return hv;
          }
          return null;
        };

  const allKeysLower: string[] = [];
  if (source instanceof Headers) {
    source.forEach((_, k) => allKeysLower.push(k.toLowerCase()));
  } else {
    for (const k of Object.keys(source)) allKeysLower.push(k.toLowerCase());
  }

  const knownSet = new Set<string>(CANONICAL_BR_HEADERS);
  const optionalSet = new Set<string>(KNOWN_OPTIONAL_BR_HEADERS);
  const unknownHeaders: string[] = [];
  for (const k of allKeysLower) {
    if (!k.startsWith("x-br-")) continue;
    if (knownSet.has(k) || optionalSet.has(k)) continue;
    unknownHeaders.push(k);
  }

  return {
    // identity
    build: get("x-br-build") ?? undefined,
    envelope: get("x-br-envelope") ?? undefined,
    tier: get("x-br-tier") ?? undefined,
    reputationTier: get("x-br-reputation-tier") ?? undefined,
    modelContract: get("x-br-model-contract") ?? undefined,
    // cost
    actualCost: num(get("x-br-actual-cost")),
    estimatedCost: num(get("x-br-estimated-cost")),
    estimatedCostCents: num(get("x-br-estimated-cost-cents")),
    routingSavings: num(get("x-br-routing-savings")),
    // budget
    budgetRemaining: num(get("x-br-budget-remaining")),
    tokensRemaining: num(get("x-br-tokens-remaining")),
    requestsRemaining: num(get("x-br-requests-remaining")),
    // latency
    totalLatencyMs: num(get("x-br-total-latency-ms")),
    providerLatencyMs: num(get("x-br-provider-latency-ms")),
    routingOverheadMs: num(get("x-br-routing-overhead-ms")),
    guardianOverheadMs: num(get("x-br-guardian-overhead-ms")),
    // routing
    routedModel: get("x-br-routed-model") ?? undefined,
    routeReason: get("x-br-route-reason") ?? undefined,
    routeConfidence: num(get("x-br-route-confidence")),
    routingReasoning: tryJson(get("x-br-routing-reasoning")),
    selectionMethod: get("x-br-selection-method") ?? undefined,
    selectionConfidence: num(get("x-br-selection-confidence")),
    modelsConsidered: num(get("x-br-models-considered")),
    qualityTier: get("x-br-quality-tier") ?? undefined,
    qualityScore: num(get("x-br-quality-score")),
    // task
    complexityLevel: get("x-br-complexity-level") ?? undefined,
    complexityScore: num(get("x-br-complexity-score")),
    // audit
    auditHash: get("x-br-audit-hash") ?? undefined,
    context: tryJson(get("x-br-context")),
    // guardian / rails
    guardianStatus: get("x-br-guardian-status") ?? undefined,
    guardrailStatus: get("x-br-guardrail-status") ?? undefined,
    guardrailSummary: get("x-br-guardrail-summary") ?? undefined,
    guardrailActions: tryDecodeJson(get("x-br-guardrail-actions")),
    // lifecycle
    degradationLevel: num(get("x-br-degradation-level")),
    deprecation: get("x-br-deprecation") ?? undefined,
    // cache
    cache: get("x-br-cache") ?? undefined,
    cacheAge: num(get("x-br-cache-age")),
    cacheSimilarity: num(get("x-br-cache-similarity")),
    coldStartMs: num(get("x-br-cold-start-ms")),
    // drift
    unknownHeaders,
  };
}

/**
 * Callback fired per BR response with the parsed envelope.
 *
 * Listeners MAY return a Promise (async listeners are explicitly supported).
 * Async rejections are caught + logged by the SaaS provider's invocation
 * site so a misbehaving listener cannot escape into the fetch path as an
 * unhandled rejection. The fetch path never awaits the listener — it is
 * fire-and-forget by design (per-turn cost telemetry MUST NOT block the
 * agent's request/response).
 */
export type BrEnvelopeListener = (envelope: BrEnvelope) => void | Promise<void>;
