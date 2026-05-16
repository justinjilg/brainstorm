/**
 * P2b wiring helper — turns a parsed BrEnvelope into a row insert against
 * routing_audit. Returns a listener that's safe to hand to
 * `createProviderRegistry({ onEnvelope })`.
 *
 * The producer (providers package) doesn't know about the db; the consumer
 * (cli bootstrap) wires the two ends together via this helper. Crossing the
 * package boundary that way keeps providers DB-free.
 *
 * Failure semantics: per-turn persistence MUST NOT crash the request. Any
 * thrown error is swallowed with an opt-in `onError` hook (defaults to a
 * console.warn). The fetch path in brainstorm-saas.ts already wraps the
 * listener in a .catch(); this is belt-and-braces for synchronous throws
 * inside the listener.
 */

import type {
  RoutingAuditRepository,
  RoutingAuditEntry,
} from "./routing-audit-repository.js";

/** Shape of the envelope this helper consumes. Kept structural (not an
 *  import of BrEnvelope) so @brainst0rm/db does not depend on
 *  @brainst0rm/providers — the dependency must point one way only.
 *
 *  Every field is optional because BR may omit any header on a degraded
 *  response; the parser produces undefined rather than failing. We only
 *  require `requestId` because it's the table's primary key.
 *
 *  Field coverage matches BrEnvelope 1:1 by name. Not every field is
 *  persisted to routing_audit (see PERSISTED_BR_ENVELOPE_FIELDS and the
 *  IGNORED set below) — but accepting the field here means future
 *  schema-extension PRs don't need to re-thread the type. The drift
 *  test in __tests__/routing-audit-writer-drift.test.ts asserts every
 *  parsed envelope field appears either in the persisted set or the
 *  documented-ignored set.
 */
export interface BrEnvelopeLike {
  // identity
  requestId?: string;
  build?: string;
  envelope?: string;
  tier?: string;
  reputationTier?: string;
  modelContract?: string;
  // cost
  actualCost?: number;
  estimatedCost?: number;
  estimatedCostCents?: number;
  routingSavings?: number;
  // budget
  budgetRemaining?: number;
  tokensRemaining?: number;
  requestsRemaining?: number;
  // latency
  totalLatencyMs?: number;
  providerLatencyMs?: number;
  routingOverheadMs?: number;
  guardianOverheadMs?: number;
  // routing
  routedModel?: string;
  routeReason?: string;
  routeConfidence?: number;
  routingReasoning?: unknown;
  selectionMethod?: string;
  selectionConfidence?: number;
  modelsConsidered?: number;
  qualityTier?: string;
  qualityScore?: number;
  // task complexity
  complexityLevel?: string;
  complexityScore?: number;
  // audit
  auditHash?: string;
  context?: unknown;
  // guardian / guardrail
  guardianStatus?: string;
  guardrailStatus?: string;
  guardrailSummary?: string;
  guardrailActions?: unknown;
  // lifecycle
  degradationLevel?: number;
  deprecation?: string;
  // cache
  cache?: string;
  cacheAge?: number;
  cacheSimilarity?: number;
  coldStartMs?: number;
  // drift sentinel from parser; we explicitly do not persist this —
  // it's a parser-internal counter for fields outside the canonical set
  unknownHeaders?: string[];
}

/**
 * Envelope fields the routing_audit table currently persists. Updates
 * to this set MUST accompany a schema migration in client.ts.
 * The drift test asserts every persisted field has a column.
 */
export const PERSISTED_BR_ENVELOPE_FIELDS = [
  "requestId",
  "build",
  "envelope",
  "tier",
  "reputationTier",
  "actualCost",
  "estimatedCost",
  "routingSavings",
  "budgetRemaining",
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
  "auditHash",
  "context",
  "guardianStatus",
  "guardrailStatus",
  "degradationLevel",
  "deprecation",
  "cache",
  "cacheAge",
  "coldStartMs",
] as const;

/**
 * Envelope fields the parser captures but we intentionally do NOT
 * persist. Each entry must have a one-line rationale. Adding a field
 * here is documented technical debt; removing one is a schema bump.
 */
export const IGNORED_BR_ENVELOPE_FIELDS: Readonly<Record<string, string>> = {
  // routing_audit is per-request; subscription tier metadata doesn't
  // vary per-row and adds no audit value vs. cost/route fields
  modelContract: "static per subscription; carried in /v1/ops/status",
  // cents column would duplicate `actualCost` (USD) with a rounding
  // hazard; downstream consumers should derive from actualCost
  estimatedCostCents: "duplicates estimatedCost (USD) with rounding hazard",
  // budget snapshots — drift fast, low audit value, surface via /budget
  tokensRemaining: "drifts every request; surface via storm budget",
  requestsRemaining: "drifts every request; surface via storm budget",
  // complexity is a routing input, captured in routing_reasoning JSON
  complexityLevel: "captured inside routing_reasoning JSON blob",
  complexityScore: "captured inside routing_reasoning JSON blob",
  // guardrail summary + actions are display-only; full structure
  // belongs in compliance_events table, not the routing per-row audit
  guardrailSummary: "display-only; full structure goes in compliance_events",
  guardrailActions: "display-only; full structure goes in compliance_events",
  // similarity score is internal to BR's cache implementation, not
  // a routing decision factor we audit on
  cacheSimilarity: "BR-internal cache implementation detail",
  // parser-internal drift sentinel — should always be [] in healthy state;
  // non-empty entries are alerted at parse time, not stored per-row
  unknownHeaders: "parser-internal drift sentinel; alerts at parse time",
};

export interface WireRoutingAuditOptions {
  onError?: (err: unknown, envelope: BrEnvelopeLike) => void;
}

export function envelopeToAuditEntry(
  env: BrEnvelopeLike,
): RoutingAuditEntry | null {
  // Without a requestId we have no primary key; drop silently. This is the
  // expected path when a proxy strips x-request-id, NOT a bug.
  if (!env.requestId) return null;
  return {
    requestId: env.requestId,
    auditHash: env.auditHash,
    envelopeMode: env.envelope,
    routedModel: env.routedModel,
    routeReason: env.routeReason,
    routeConfidence: env.routeConfidence,
    selectionMethod: env.selectionMethod,
    selectionConfidence: env.selectionConfidence,
    qualityTier: env.qualityTier,
    qualityScore: env.qualityScore,
    modelsConsidered: env.modelsConsidered,
    actualCostUsd: env.actualCost,
    estimatedCostUsd: env.estimatedCost,
    routingSavingsUsd: env.routingSavings,
    budgetRemainingUsd: env.budgetRemaining,
    totalLatencyMs: env.totalLatencyMs,
    providerLatencyMs: env.providerLatencyMs,
    routingOverheadMs: env.routingOverheadMs,
    guardianOverheadMs: env.guardianOverheadMs,
    guardianStatus: env.guardianStatus,
    guardrailStatus: env.guardrailStatus,
    reputationTier: env.reputationTier,
    tier: env.tier,
    degradationLevel: env.degradationLevel,
    deprecationNotice: env.deprecation,
    cacheState: env.cache,
    cacheAgeMs: env.cacheAge,
    coldStartMs: env.coldStartMs,
    brBuild: env.build,
    routingReasoning: env.routingReasoning,
    context: env.context,
  };
}

/**
 * Build the listener. Pass the returned function as `onEnvelope` to
 * `createProviderRegistry`. Each BR response flows through here and lands
 * as a row in routing_audit, keyed on x-request-id.
 */
export function wireRoutingAudit(
  repo: RoutingAuditRepository,
  options: WireRoutingAuditOptions = {},
): (env: BrEnvelopeLike) => void {
  const onError =
    options.onError ??
    ((err: unknown) => {
      // Best-effort write — don't crash the agent because the audit
      // table is unavailable. Surface the error so a human can see it.
      // eslint-disable-next-line no-console
      console.warn("[routing-audit] insert failed:", err);
    });
  return (env: BrEnvelopeLike) => {
    try {
      const entry = envelopeToAuditEntry(env);
      if (entry) repo.insert(entry);
    } catch (err) {
      onError(err, env);
    }
  };
}
