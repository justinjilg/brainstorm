/**
 * RoutingAuditRepository — per-request BR envelope persistence.
 *
 * Stores the full BR `x-br-*` response envelope per chat completion, keyed
 * on `x-request-id` (from the response). Enables:
 *
 *   1. Verifiable audit chain — given an audit-hash, look up the full
 *      routing context (model picked, why, cost, quality tier, confidence,
 *      guardrail state).
 *   2. Trajectory enrichment — when submitting trajectories to BR via
 *      /v1/agent/trajectory, attach the per-turn audit-hashes so the
 *      submitted trail is continuous with BR's own evidence ledger.
 *   3. Operator observability — `storm dashboard` queries this table to
 *      show "last 10 routes" with model/cost/confidence/savings.
 *
 * Complementary to `model_performance_v2` (Thompson-sampling aggregates).
 * This is the per-turn detail; that is the rolled-up summary.
 *
 * Drives Path-to-90 D5/D6/D8.
 */

import type Database from "better-sqlite3";

export interface RoutingAuditEntry {
  /** x-request-id — primary key. */
  requestId: string;
  /** x-br-audit-hash (64-hex chain pointer to BR's evidence ledger). */
  auditHash?: string;
  /** x-br-envelope mode ("audit" / "enforce" / etc.). */
  envelopeMode?: string;
  /** x-br-routed-model (the actual model BR routed to). */
  routedModel?: string;
  /** x-br-route-reason. */
  routeReason?: string;
  /** x-br-route-confidence (0-1). */
  routeConfidence?: number;
  /** x-br-selection-method. */
  selectionMethod?: string;
  /** x-br-selection-confidence (0-1). */
  selectionConfidence?: number;
  /** x-br-quality-tier ("heuristic"/"learned"/"verified"). */
  qualityTier?: string;
  /** x-br-quality-score (0-1). */
  qualityScore?: number;
  /** x-br-models-considered. */
  modelsConsidered?: number;
  /** x-br-actual-cost (USD). */
  actualCostUsd?: number;
  /** x-br-estimated-cost (USD). */
  estimatedCostUsd?: number;
  /** x-br-routing-savings (USD vs naive routing). */
  routingSavingsUsd?: number;
  /** x-br-budget-remaining (USD). */
  budgetRemainingUsd?: number;
  /** x-br-total-latency-ms (end-to-end). */
  totalLatencyMs?: number;
  /** x-br-provider-latency-ms. */
  providerLatencyMs?: number;
  /** x-br-routing-overhead-ms. */
  routingOverheadMs?: number;
  /** x-br-guardian-overhead-ms. */
  guardianOverheadMs?: number;
  /** x-br-guardian-status. */
  guardianStatus?: string;
  /** x-br-guardrail-status ("warn"/"enforce"/"off"). */
  guardrailStatus?: string;
  /** x-br-reputation-tier (caller). */
  reputationTier?: string;
  /** x-br-tier (subscription tier). */
  tier?: string;
  /** x-br-degradation-level (0 nominal, >0 degraded). */
  degradationLevel?: number;
  /** x-br-deprecation (sunset notice). */
  deprecationNotice?: string;
  /** x-br-cache state ("hit"/"miss"/"skip"). */
  cacheState?: string;
  /** x-br-cache-age (ms when cache=hit). */
  cacheAgeMs?: number;
  /** x-br-cold-start-ms. */
  coldStartMs?: number;
  /** x-br-build (BR commit SHA short). */
  brBuild?: string;
  /** x-br-routing-reasoning (parsed JSON or raw string). */
  routingReasoning?: unknown;
  /** x-br-context (parsed JSON or raw string). */
  context?: unknown;
  /** Unix seconds; defaults to now if omitted. */
  capturedAt?: number;
}

/** Per-row shape returned from listRecent — flat for ergonomic UI rendering. */
export interface RoutingAuditRow extends Omit<RoutingAuditEntry, "capturedAt"> {
  capturedAt: number;
}

export class RoutingAuditRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert a routing audit entry. Idempotent on `requestId` — re-inserting
   * the same request_id is treated as an update (BR may emit a corrected
   * envelope on retry). `audit_hash` is what changes; we keep the latest.
   */
  insert(entry: RoutingAuditEntry): void {
    if (!entry.requestId || entry.requestId.length === 0) {
      throw new Error("RoutingAuditRepository.insert: requestId required");
    }
    const capturedAt = entry.capturedAt ?? Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO routing_audit (
          request_id, audit_hash, envelope_mode, routed_model, route_reason,
          route_confidence, selection_method, selection_confidence,
          quality_tier, quality_score, models_considered,
          actual_cost_usd, estimated_cost_usd, routing_savings_usd,
          budget_remaining_usd, total_latency_ms, provider_latency_ms,
          routing_overhead_ms, guardian_overhead_ms, guardian_status,
          guardrail_status, reputation_tier, tier, degradation_level,
          deprecation_notice, cache_state, cache_age_ms, cold_start_ms,
          br_build, routing_reasoning_json, context_json, captured_at
        ) VALUES (
          @requestId, @auditHash, @envelopeMode, @routedModel, @routeReason,
          @routeConfidence, @selectionMethod, @selectionConfidence,
          @qualityTier, @qualityScore, @modelsConsidered,
          @actualCostUsd, @estimatedCostUsd, @routingSavingsUsd,
          @budgetRemainingUsd, @totalLatencyMs, @providerLatencyMs,
          @routingOverheadMs, @guardianOverheadMs, @guardianStatus,
          @guardrailStatus, @reputationTier, @tier, @degradationLevel,
          @deprecationNotice, @cacheState, @cacheAgeMs, @coldStartMs,
          @brBuild, @routingReasoningJson, @contextJson, @capturedAt
        )`,
      )
      .run({
        requestId: entry.requestId,
        auditHash: entry.auditHash ?? null,
        envelopeMode: entry.envelopeMode ?? null,
        routedModel: entry.routedModel ?? null,
        routeReason: entry.routeReason ?? null,
        routeConfidence: entry.routeConfidence ?? null,
        selectionMethod: entry.selectionMethod ?? null,
        selectionConfidence: entry.selectionConfidence ?? null,
        qualityTier: entry.qualityTier ?? null,
        qualityScore: entry.qualityScore ?? null,
        modelsConsidered: entry.modelsConsidered ?? null,
        actualCostUsd: entry.actualCostUsd ?? null,
        estimatedCostUsd: entry.estimatedCostUsd ?? null,
        routingSavingsUsd: entry.routingSavingsUsd ?? null,
        budgetRemainingUsd: entry.budgetRemainingUsd ?? null,
        totalLatencyMs: entry.totalLatencyMs ?? null,
        providerLatencyMs: entry.providerLatencyMs ?? null,
        routingOverheadMs: entry.routingOverheadMs ?? null,
        guardianOverheadMs: entry.guardianOverheadMs ?? null,
        guardianStatus: entry.guardianStatus ?? null,
        guardrailStatus: entry.guardrailStatus ?? null,
        reputationTier: entry.reputationTier ?? null,
        tier: entry.tier ?? null,
        degradationLevel: entry.degradationLevel ?? null,
        deprecationNotice: entry.deprecationNotice ?? null,
        cacheState: entry.cacheState ?? null,
        cacheAgeMs: entry.cacheAgeMs ?? null,
        coldStartMs: entry.coldStartMs ?? null,
        brBuild: entry.brBuild ?? null,
        routingReasoningJson:
          entry.routingReasoning !== undefined
            ? JSON.stringify(entry.routingReasoning)
            : null,
        contextJson:
          entry.context !== undefined ? JSON.stringify(entry.context) : null,
        capturedAt,
      });
  }

  /** Look up a single audit entry by request id. */
  get(requestId: string): RoutingAuditRow | null {
    const row = this.db
      .prepare("SELECT * FROM routing_audit WHERE request_id = ?")
      .get(requestId) as any;
    return row ? rowToEntry(row) : null;
  }

  /** Look up an entry by BR's audit_hash (the chain pointer). */
  lookupByAuditHash(auditHash: string): RoutingAuditRow | null {
    const row = this.db
      .prepare("SELECT * FROM routing_audit WHERE audit_hash = ?")
      .get(auditHash) as any;
    return row ? rowToEntry(row) : null;
  }

  /**
   * Recent entries, newest first. Drives dashboard "last N routes" view.
   * Cap default at 50 to keep render cost bounded.
   */
  listRecent(limit = 50): RoutingAuditRow[] {
    const rows = this.db
      .prepare("SELECT * FROM routing_audit ORDER BY captured_at DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(rowToEntry);
  }

  /**
   * Return all audit_hash values for a window. Used by trajectory submission
   * to attach BR's chain pointers to outgoing trajectory payloads — closes
   * the evidence loop documented in path-to-90 plan P2.
   */
  listAuditHashesSince(sinceUnixSec: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT audit_hash FROM routing_audit
         WHERE captured_at >= ? AND audit_hash IS NOT NULL
         ORDER BY captured_at ASC`,
      )
      .all(sinceUnixSec) as Array<{ audit_hash: string }>;
    return rows.map((r) => r.audit_hash);
  }

  /** Count rows. Useful in tests + dashboard ops summary. */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM routing_audit")
      .get() as { n: number };
    return row.n;
  }

  /**
   * Delete audit rows older than the given unix-second cutoff. Returns
   * the number of rows deleted. Called by cleanupOldRecords on every
   * DB open to bound table growth.
   *
   * v16 Architect: without this, routing_audit grows unbounded at scale.
   * A heavy CLI user makes ~10k chat turns/month; over a year that's
   * ~120k rows. With this method capped at the same 90-day window as
   * other tables (cost_records, model_performance), the table stays
   * bounded at ~30k rows for typical usage.
   */
  deleteOlderThan(cutoffUnixSec: number): number {
    const result = this.db
      .prepare("DELETE FROM routing_audit WHERE captured_at < ?")
      .run(cutoffUnixSec);
    return result.changes;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function rowToEntry(row: any): RoutingAuditRow {
  return {
    requestId: row.request_id,
    auditHash: row.audit_hash ?? undefined,
    envelopeMode: row.envelope_mode ?? undefined,
    routedModel: row.routed_model ?? undefined,
    routeReason: row.route_reason ?? undefined,
    routeConfidence: row.route_confidence ?? undefined,
    selectionMethod: row.selection_method ?? undefined,
    selectionConfidence: row.selection_confidence ?? undefined,
    qualityTier: row.quality_tier ?? undefined,
    qualityScore: row.quality_score ?? undefined,
    modelsConsidered: row.models_considered ?? undefined,
    actualCostUsd: row.actual_cost_usd ?? undefined,
    estimatedCostUsd: row.estimated_cost_usd ?? undefined,
    routingSavingsUsd: row.routing_savings_usd ?? undefined,
    budgetRemainingUsd: row.budget_remaining_usd ?? undefined,
    totalLatencyMs: row.total_latency_ms ?? undefined,
    providerLatencyMs: row.provider_latency_ms ?? undefined,
    routingOverheadMs: row.routing_overhead_ms ?? undefined,
    guardianOverheadMs: row.guardian_overhead_ms ?? undefined,
    guardianStatus: row.guardian_status ?? undefined,
    guardrailStatus: row.guardrail_status ?? undefined,
    reputationTier: row.reputation_tier ?? undefined,
    tier: row.tier ?? undefined,
    degradationLevel: row.degradation_level ?? undefined,
    deprecationNotice: row.deprecation_notice ?? undefined,
    cacheState: row.cache_state ?? undefined,
    cacheAgeMs: row.cache_age_ms ?? undefined,
    coldStartMs: row.cold_start_ms ?? undefined,
    brBuild: row.br_build ?? undefined,
    routingReasoning: safeJsonParse(row.routing_reasoning_json),
    context: safeJsonParse(row.context_json),
    capturedAt: row.captured_at,
  };
}

function safeJsonParse(raw: string | null): unknown {
  if (raw == null || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
