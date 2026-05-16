/**
 * P2b wiring tests — envelope-shaped objects round-trip into routing_audit.
 *
 * Asserts:
 *   - envelopeToAuditEntry maps every cross-named field correctly
 *     (envelope.actualCost → entry.actualCostUsd, etc.)
 *   - missing requestId returns null (drop, don't crash)
 *   - wireRoutingAudit listener inserts the row + lookupByAuditHash finds it
 *   - listener swallows repository throws via onError hook (production
 *     persistence MUST NOT crash the agent turn)
 */

import { describe, it, expect, vi } from "vitest";
import { getTestDb } from "../client.js";
import { RoutingAuditRepository } from "../routing-audit-repository.js";
import {
  envelopeToAuditEntry,
  wireRoutingAudit,
  type BrEnvelopeLike,
} from "../routing-audit-writer.js";

function makeEnvelope(overrides: Partial<BrEnvelopeLike> = {}): BrEnvelopeLike {
  return {
    requestId: "req-aaa",
    auditHash:
      "590439b4451f67ea3ce43942edd66f831b1bd3ffd2c625f1e78898196314c285",
    envelope: "audit",
    routedModel: "deepseek/deepseek-chat",
    routeReason: "explicit",
    routeConfidence: 0.1,
    selectionMethod: "explicit",
    selectionConfidence: 1.0,
    qualityTier: "heuristic",
    qualityScore: 0.8,
    modelsConsidered: 1,
    actualCost: 0.000037,
    estimatedCost: 0,
    routingSavings: 0.003188,
    budgetRemaining: 4.95,
    totalLatencyMs: 1247,
    providerLatencyMs: 1100,
    routingOverheadMs: 12,
    guardianOverheadMs: 8,
    guardianStatus: "on",
    guardrailStatus: "off",
    reputationTier: "silver",
    tier: "community",
    degradationLevel: 0,
    cache: "miss",
    coldStartMs: 42,
    build: "1b3c127",
    routingReasoning: { picked: "cost" },
    context: { model: "deepseek/deepseek-chat" },
    ...overrides,
  };
}

describe("envelopeToAuditEntry", () => {
  it("renames camelCase envelope fields to *Usd / *Ms entry fields", () => {
    const env = makeEnvelope();
    const entry = envelopeToAuditEntry(env);
    expect(entry).not.toBeNull();
    expect(entry!.actualCostUsd).toBe(0.000037);
    expect(entry!.estimatedCostUsd).toBe(0);
    expect(entry!.routingSavingsUsd).toBe(0.003188);
    expect(entry!.budgetRemainingUsd).toBe(4.95);
    expect(entry!.totalLatencyMs).toBe(1247);
    expect(entry!.cacheAgeMs).toBeUndefined();
    expect(entry!.envelopeMode).toBe("audit");
    expect(entry!.brBuild).toBe("1b3c127");
    expect(entry!.deprecationNotice).toBeUndefined();
  });

  it("returns null when requestId is missing — drop silently", () => {
    const entry = envelopeToAuditEntry({ requestId: undefined });
    expect(entry).toBeNull();
  });

  it("passes structured fields through untouched", () => {
    const env = makeEnvelope({
      routingReasoning: { picked: "quality", score: 0.92 },
      context: { tenantId: "abc-123" },
    });
    const entry = envelopeToAuditEntry(env);
    expect(entry!.routingReasoning).toEqual({ picked: "quality", score: 0.92 });
    expect(entry!.context).toEqual({ tenantId: "abc-123" });
  });
});

describe("wireRoutingAudit", () => {
  it("inserts a row that lookupByAuditHash finds", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    const listener = wireRoutingAudit(repo);

    const envelope = makeEnvelope({ requestId: "req-wire-1" });
    listener(envelope);

    const row = repo.lookupByAuditHash(envelope.auditHash!);
    expect(row).not.toBeNull();
    expect(row!.requestId).toBe("req-wire-1");
    expect(row!.routedModel).toBe("deepseek/deepseek-chat");
    expect(row!.actualCostUsd).toBe(0.000037);
  });

  it("drops envelopes without requestId without throwing", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    const listener = wireRoutingAudit(repo);

    expect(() => listener({ auditHash: "abc" })).not.toThrow();
    expect(repo.count()).toBe(0);
  });

  it("swallows repository throws via onError", () => {
    const onError = vi.fn();
    const fakeRepo = {
      insert: () => {
        throw new Error("disk full");
      },
    } as unknown as RoutingAuditRepository;
    const listener = wireRoutingAudit(fakeRepo, { onError });

    expect(() => listener(makeEnvelope())).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0][0] as Error).message).toBe("disk full");
  });
});
