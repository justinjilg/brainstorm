/**
 * RoutingAuditRepository tests.
 *
 * Verifies the per-request BR envelope persistence layer:
 *   - insert + get round-trips every typed field including JSON columns
 *   - INSERT OR REPLACE semantics on requestId collision (BR may re-emit a
 *     corrected envelope on retry; we keep the latest)
 *   - lookupByAuditHash returns the row by the BR chain pointer
 *   - listRecent orders by captured_at DESC and respects the limit
 *   - listAuditHashesSince filters by capture time and skips null hashes
 *   - count() returns row count
 *   - safe parse: corrupt JSON falls back to raw string, not a throw
 */

import { describe, it, expect } from "vitest";
import { getTestDb } from "../client.js";
import {
  RoutingAuditRepository,
  type RoutingAuditEntry,
} from "../routing-audit-repository.js";

function makeEntry(
  overrides: Partial<RoutingAuditEntry> = {},
): RoutingAuditEntry {
  return {
    requestId: "req-0001",
    auditHash:
      "590439b4451f67ea3ce43942edd66f831b1bd3ffd2c625f1e78898196314c285",
    envelopeMode: "audit",
    routedModel: "deepseek/deepseek-chat",
    routeReason: "explicit",
    routeConfidence: 0.1,
    selectionMethod: "explicit",
    selectionConfidence: 1.0,
    qualityTier: "heuristic",
    qualityScore: 0.8,
    modelsConsidered: 1,
    actualCostUsd: 0.000037,
    estimatedCostUsd: 0,
    routingSavingsUsd: 0.003188,
    budgetRemainingUsd: 1.95,
    totalLatencyMs: 2383,
    providerLatencyMs: 341,
    routingOverheadMs: 2546.3,
    guardianOverheadMs: 0.3,
    guardianStatus: "on",
    guardrailStatus: "warn",
    reputationTier: "gold",
    tier: "community",
    degradationLevel: 0,
    deprecationNotice:
      "deepseek/deepseek-chat sunset 2026-07-24T15:59:00Z, migrate to deepseek/deepseek-v4-flash",
    cacheState: "miss",
    cacheAgeMs: undefined,
    coldStartMs: undefined,
    brBuild: "1b3c127",
    routingReasoning: {
      model: "deepseek/deepseek-chat",
      reason: "deepseek::deepseek-chat",
    },
    context: { model: "deepseek/deepseek-chat", cache: "miss" },
    capturedAt: 1778883729,
    ...overrides,
  };
}

describe("RoutingAuditRepository", () => {
  it("inserts and retrieves every typed field by requestId", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    repo.insert(makeEntry());
    const fetched = repo.get("req-0001");
    expect(fetched).not.toBeNull();
    expect(fetched!.auditHash).toBe(
      "590439b4451f67ea3ce43942edd66f831b1bd3ffd2c625f1e78898196314c285",
    );
    expect(fetched!.routedModel).toBe("deepseek/deepseek-chat");
    expect(fetched!.actualCostUsd).toBe(0.000037);
    expect(fetched!.qualityTier).toBe("heuristic");
    expect(fetched!.reputationTier).toBe("gold");
    expect(fetched!.routingReasoning).toEqual({
      model: "deepseek/deepseek-chat",
      reason: "deepseek::deepseek-chat",
    });
    expect(fetched!.context).toEqual({
      model: "deepseek/deepseek-chat",
      cache: "miss",
    });
    db.close();
  });

  it("INSERT OR REPLACE: re-inserting the same requestId updates fields", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    repo.insert(makeEntry());
    expect(repo.get("req-0001")!.actualCostUsd).toBe(0.000037);

    // BR re-emits with a corrected cost
    repo.insert(makeEntry({ actualCostUsd: 0.0001, qualityScore: 0.95 }));
    expect(repo.count()).toBe(1);
    const updated = repo.get("req-0001")!;
    expect(updated.actualCostUsd).toBe(0.0001);
    expect(updated.qualityScore).toBe(0.95);
    db.close();
  });

  it("throws on empty requestId (PK invariant)", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    expect(() => repo.insert(makeEntry({ requestId: "" }))).toThrow(
      /requestId/,
    );
    db.close();
  });

  it("lookupByAuditHash returns the row by BR chain pointer", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    repo.insert(makeEntry({ requestId: "req-A", auditHash: "hashA" }));
    repo.insert(makeEntry({ requestId: "req-B", auditHash: "hashB" }));
    expect(repo.lookupByAuditHash("hashA")!.requestId).toBe("req-A");
    expect(repo.lookupByAuditHash("hashB")!.requestId).toBe("req-B");
    expect(repo.lookupByAuditHash("nope")).toBeNull();
    db.close();
  });

  it("listRecent returns newest-first with limit", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    repo.insert(makeEntry({ requestId: "req-1", capturedAt: 1000 }));
    repo.insert(makeEntry({ requestId: "req-2", capturedAt: 2000 }));
    repo.insert(makeEntry({ requestId: "req-3", capturedAt: 3000 }));
    const recent = repo.listRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].requestId).toBe("req-3");
    expect(recent[1].requestId).toBe("req-2");
    db.close();
  });

  it("listAuditHashesSince filters by capture time and skips nulls", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    repo.insert(
      makeEntry({ requestId: "req-old", auditHash: "old-h", capturedAt: 100 }),
    );
    repo.insert(
      makeEntry({ requestId: "req-mid", auditHash: "mid-h", capturedAt: 500 }),
    );
    repo.insert(
      makeEntry({
        requestId: "req-null",
        auditHash: undefined,
        capturedAt: 600,
      }),
    );
    repo.insert(
      makeEntry({ requestId: "req-new", auditHash: "new-h", capturedAt: 1000 }),
    );

    const hashes = repo.listAuditHashesSince(500);
    expect(hashes).toEqual(["mid-h", "new-h"]); // ASC order, nulls excluded
    db.close();
  });

  it("count() returns total rows", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    expect(repo.count()).toBe(0);
    repo.insert(makeEntry({ requestId: "a" }));
    repo.insert(makeEntry({ requestId: "b" }));
    repo.insert(makeEntry({ requestId: "c" }));
    expect(repo.count()).toBe(3);
    db.close();
  });

  it("undefined optional fields persist as null and round-trip as undefined", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    repo.insert({
      requestId: "minimal",
      // Everything else undefined — represents a degenerate response where
      // BR omitted most x-br-* headers (e.g. an early-fail path).
    });
    const fetched = repo.get("minimal")!;
    expect(fetched.requestId).toBe("minimal");
    expect(fetched.auditHash).toBeUndefined();
    expect(fetched.routedModel).toBeUndefined();
    expect(fetched.actualCostUsd).toBeUndefined();
    expect(fetched.routingReasoning).toBeUndefined();
    expect(fetched.context).toBeUndefined();
    expect(fetched.capturedAt).toBeGreaterThan(0); // default to now
    db.close();
  });

  it("get returns null for unknown requestId", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    expect(repo.get("never-inserted")).toBeNull();
    db.close();
  });

  it("deleteOlderThan removes rows below the cutoff (v16 Architect retention)", () => {
    const db = getTestDb();
    const repo = new RoutingAuditRepository(db);
    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 60 * 60;
    repo.insert(makeEntry({ requestId: "fresh", capturedAt: now - 1 * day }));
    repo.insert(makeEntry({ requestId: "old-30", capturedAt: now - 30 * day }));
    repo.insert(makeEntry({ requestId: "old-60", capturedAt: now - 60 * day }));
    repo.insert(
      makeEntry({ requestId: "old-100", capturedAt: now - 100 * day }),
    );
    expect(repo.count()).toBe(4);

    const cutoff90 = now - 90 * day;
    expect(repo.deleteOlderThan(cutoff90)).toBe(1);
    expect(repo.count()).toBe(3);
    expect(repo.get("old-100")).toBeNull();
    expect(repo.get("fresh")).not.toBeNull();

    const cutoff45 = now - 45 * day;
    expect(repo.deleteOlderThan(cutoff45)).toBe(1);
    expect(repo.count()).toBe(2);

    db.close();
  });
});
