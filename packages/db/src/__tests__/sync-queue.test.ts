/**
 * SyncQueueRepository tests.
 *
 * Pins the retry-queue state machine: enqueue with idempotency,
 * claim-batch atomicity, exponential backoff on failure, permanent
 * failure after max attempts, stats aggregation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getTestDb } from "../client.js";
import { SyncQueueRepository } from "../repositories.js";

let db: Database.Database;
let repo: SyncQueueRepository;

beforeEach(() => {
  db = getTestDb();
  repo = new SyncQueueRepository(db);
});

afterEach(() => {
  db.close();
});

describe("SyncQueueRepository", () => {
  describe("enqueue", () => {
    it("creates a pending row with all fields set", () => {
      const row = repo.enqueue({
        kind: "memory-entry",
        method: "POST",
        path: "/v1/memory/entries",
        body: { block: "semantic", content: "hello" },
        idempotencyKey: "mem-abc-1",
      });

      expect(row.status).toBe("pending");
      expect(row.kind).toBe("memory-entry");
      expect(row.method).toBe("POST");
      expect(row.path).toBe("/v1/memory/entries");
      expect(row.body).toBe(
        JSON.stringify({ block: "semantic", content: "hello" }),
      );
      expect(row.idempotencyKey).toBe("mem-abc-1");
      expect(row.attemptCount).toBe(0);
      expect(row.maxAttempts).toBe(10);
      expect(row.nextAttemptAt).toBeGreaterThan(0);
    });

    it("deduplicates by idempotencyKey — returns existing pending row", () => {
      const first = repo.enqueue({
        kind: "memory-entry",
        method: "POST",
        path: "/v1/memory/entries",
        body: { block: "semantic", content: "hello" },
        idempotencyKey: "stable-key-1",
      });

      const second = repo.enqueue({
        kind: "memory-entry",
        method: "POST",
        path: "/v1/memory/entries",
        body: { block: "semantic", content: "hello-updated" }, // different body
        idempotencyKey: "stable-key-1",
      });

      expect(second.id).toBe(first.id);
      // Body was NOT updated — we return the existing row as-is
      expect(second.body).toContain("hello");
      expect(second.body).not.toContain("hello-updated");
    });

    it("allows a new enqueue with same idempotencyKey after the old one completes", () => {
      const first = repo.enqueue({
        kind: "memory-entry",
        method: "POST",
        path: "/v1/memory/entries",
        idempotencyKey: "key-1",
      });
      repo.markCompleted(first.id);

      const second = repo.enqueue({
        kind: "memory-entry",
        method: "POST",
        path: "/v1/memory/entries",
        idempotencyKey: "key-1",
      });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("pending");
    });

    it("generates an idempotencyKey if not provided", () => {
      const row = repo.enqueue({
        kind: "generic",
        method: "POST",
        path: "/v1/test",
      });
      expect(row.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe("claimBatch", () => {
    it("returns pending rows in creation order", () => {
      const a = repo.enqueue({
        kind: "a",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
      });
      const b = repo.enqueue({
        kind: "b",
        method: "POST",
        path: "/b",
        idempotencyKey: "b",
      });
      const c = repo.enqueue({
        kind: "c",
        method: "POST",
        path: "/c",
        idempotencyKey: "c",
      });

      const batch = repo.claimBatch(10);
      expect(batch.map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    });

    it("marks claimed rows as in_flight", () => {
      repo.enqueue({
        kind: "a",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
      });
      const batch = repo.claimBatch(10);
      expect(batch[0].status).toBe("in_flight");

      const reloaded = repo.getById(batch[0].id);
      expect(reloaded?.status).toBe("in_flight");
    });

    it("does not return the same row on subsequent calls", () => {
      repo.enqueue({
        kind: "a",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
      });
      repo.enqueue({
        kind: "b",
        method: "POST",
        path: "/b",
        idempotencyKey: "b",
      });

      const first = repo.claimBatch(10);
      const second = repo.claimBatch(10);

      expect(first).toHaveLength(2);
      expect(second).toHaveLength(0);
    });

    it("respects the limit argument", () => {
      for (let i = 0; i < 5; i++) {
        repo.enqueue({
          kind: "a",
          method: "POST",
          path: "/a",
          idempotencyKey: `a-${i}`,
        });
      }
      const batch = repo.claimBatch(3);
      expect(batch).toHaveLength(3);
    });

    it("does not return failed or completed rows", () => {
      const a = repo.enqueue({
        kind: "a",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
      });
      const b = repo.enqueue({
        kind: "b",
        method: "POST",
        path: "/b",
        idempotencyKey: "b",
      });
      repo.markCompleted(a.id);
      repo.markFailed(b.id, "boom");
      // markFailed with attempts < max schedules a retry, not a terminal failure.
      // So b is back in pending but with a future next_attempt_at.
      const batch = repo.claimBatch(10);
      expect(batch.map((r) => r.id)).not.toContain(a.id);
      // b is still pending but its next_attempt_at is in the future, so
      // claimBatch skips it
      expect(batch.map((r) => r.id)).not.toContain(b.id);
    });
  });

  describe("markFailed — exponential backoff", () => {
    it("increments attempt count and schedules next retry", () => {
      const row = repo.enqueue({
        kind: "a",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
      });
      repo.markFailed(row.id, "network error");

      const reloaded = repo.getById(row.id)!;
      expect(reloaded.attemptCount).toBe(1);
      expect(reloaded.lastError).toBe("network error");
      expect(reloaded.status).toBe("pending");
      // First retry: base 5s + up to 20% jitter
      const now = Math.floor(Date.now() / 1000);
      expect(reloaded.nextAttemptAt).toBeGreaterThanOrEqual(now + 4);
      expect(reloaded.nextAttemptAt).toBeLessThanOrEqual(now + 8);
    });

    it("caps backoff at 1 hour", () => {
      const row = repo.enqueue({
        kind: "a",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
        maxAttempts: 20, // allow many failures
      });

      // Fail 15 times — 2^14 * 5 = 81920s, should be capped at 3600
      for (let i = 0; i < 15; i++) {
        repo.markFailed(row.id, `fail ${i}`);
      }

      const reloaded = repo.getById(row.id)!;
      expect(reloaded.attemptCount).toBe(15);
      const now = Math.floor(Date.now() / 1000);
      // Base capped at 3600 + up to 20% jitter
      expect(reloaded.nextAttemptAt).toBeLessThanOrEqual(now + 3600 + 720);
      expect(reloaded.nextAttemptAt).toBeGreaterThanOrEqual(now + 3600);
    });

    it("marks row as permanently failed after max attempts", () => {
      const row = repo.enqueue({
        kind: "a",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
        maxAttempts: 3,
      });

      repo.markFailed(row.id, "fail 1");
      repo.markFailed(row.id, "fail 2");
      repo.markFailed(row.id, "fail 3"); // hits max

      const reloaded = repo.getById(row.id)!;
      expect(reloaded.status).toBe("failed");
      expect(reloaded.attemptCount).toBe(3);
      expect(reloaded.completedAt).toBeGreaterThan(0);
    });

    it("truncates error messages to 1000 chars to avoid bloating rows", () => {
      const row = repo.enqueue({
        kind: "a",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
      });
      const hugeError = "x".repeat(5000);
      repo.markFailed(row.id, hugeError);

      const reloaded = repo.getById(row.id)!;
      expect(reloaded.lastError?.length).toBe(1000);
    });
  });

  describe("markCompleted", () => {
    it("sets completed_at and status", () => {
      const row = repo.enqueue({
        kind: "a",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
      });
      repo.markCompleted(row.id);

      const reloaded = repo.getById(row.id)!;
      expect(reloaded.status).toBe("completed");
      expect(reloaded.completedAt).toBeGreaterThan(0);
    });
  });

  describe("getStats", () => {
    it("returns zero counts for empty queue", () => {
      const stats = repo.getStats();
      expect(stats).toEqual({
        pending: 0,
        inFlight: 0,
        completed: 0,
        failed: 0,
        oldestPending: null,
        latestFailure: null,
      });
    });

    it("aggregates counts correctly across state transitions", () => {
      const a = repo.enqueue({
        kind: "x",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
      });
      const b = repo.enqueue({
        kind: "x",
        method: "POST",
        path: "/b",
        idempotencyKey: "b",
      });
      const c = repo.enqueue({
        kind: "x",
        method: "POST",
        path: "/c",
        idempotencyKey: "c",
        maxAttempts: 1,
      });

      repo.markCompleted(a.id);
      repo.markFailed(c.id, "terminal"); // maxAttempts=1, goes to failed

      const stats = repo.getStats();
      expect(stats.pending).toBe(1); // b
      expect(stats.completed).toBe(1); // a
      expect(stats.failed).toBe(1); // c
      expect(stats.oldestPending).toBeGreaterThan(0);
      expect(stats.latestFailure?.id).toBe(c.id);
      expect(stats.latestFailure?.error).toBe("terminal");
    });
  });

  describe("pruneCompleted", () => {
    it("removes old completed rows", () => {
      const a = repo.enqueue({
        kind: "x",
        method: "POST",
        path: "/a",
        idempotencyKey: "a",
      });
      repo.markCompleted(a.id);

      // Backdate the completed_at so it's older than the cutoff
      db.prepare(
        "UPDATE sync_queue SET completed_at = unixepoch() - 100000 WHERE id = ?",
      ).run(a.id);

      const pruned = repo.pruneCompleted(3600); // prune older than 1h
      expect(pruned).toBe(1);
      expect(repo.getById(a.id)).toBeNull();
    });

    it("leaves pending and in_flight rows alone", () => {
      const pending = repo.enqueue({
        kind: "x",
        method: "POST",
        path: "/p",
        idempotencyKey: "p",
      });
      const claimed = repo.enqueue({
        kind: "x",
        method: "POST",
        path: "/c",
        idempotencyKey: "c",
      });
      repo.claimBatch(10); // marks both in_flight... well, claimed is in_flight after

      const pruned = repo.pruneCompleted(0);
      expect(pruned).toBe(0);
      expect(repo.getById(pending.id)).not.toBeNull();
      expect(repo.getById(claimed.id)).not.toBeNull();
    });
  });
});
