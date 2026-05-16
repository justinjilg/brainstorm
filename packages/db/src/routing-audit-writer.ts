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
 *  require `requestId` because it's the table's primary key. */
export interface BrEnvelopeLike {
  requestId?: string;
  build?: string;
  envelope?: string;
  routedModel?: string;
  routeReason?: string;
  routeConfidence?: number;
  routingReasoning?: unknown;
  selectionMethod?: string;
  selectionConfidence?: number;
  modelsConsidered?: number;
  qualityTier?: string;
  qualityScore?: number;
  actualCost?: number;
  estimatedCost?: number;
  routingSavings?: number;
  budgetRemaining?: number;
  totalLatencyMs?: number;
  providerLatencyMs?: number;
  routingOverheadMs?: number;
  guardianOverheadMs?: number;
  guardianStatus?: string;
  guardrailStatus?: string;
  reputationTier?: string;
  tier?: string;
  degradationLevel?: number;
  deprecation?: string;
  cache?: string;
  cacheAge?: number;
  coldStartMs?: number;
  auditHash?: string;
  context?: unknown;
}

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
