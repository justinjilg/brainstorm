/**
 * SyncWorker integration tests. Uses a real SQLite db (via getTestDb)
 * with the real SyncQueueRepository, and a stubbed gateway client that
 * lets tests control success/failure per-request.
 *
 * Key behaviors pinned:
 *   - Successful drain marks items completed
 *   - Failing drain marks items for retry with backoff
 *   - Retry actually runs on the next drain pass
 *   - Idempotency key is passed to the gateway's requestRaw
 *   - Permanent failure after maxAttempts
 *   - Empty queue drain is a no-op
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { getTestDb, SyncQueueRepository } from "@brainst0rm/db";
import { SyncWorker } from "../sync-worker.js";

let db: Database.Database;
let repo: SyncQueueRepository;

// Stubbed gateway: requestRaw is a vi.fn() the test can program.
function makeStubGateway() {
  const requestRaw = vi.fn();
  return {
    gateway: { requestRaw } as any,
    requestRaw,
  };
}

beforeEach(() => {
  db = getTestDb();
  repo = new SyncQueueRepository(db);
});

afterEach(() => {
  db.close();
});

describe("SyncWorker.drainOnce", () => {
  it("is a no-op on empty queue", async () => {
    const { gateway, requestRaw } = makeStubGateway();
    const worker = new SyncWorker({ gateway, repo });

    const result = await worker.drainOnce();
    expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("marks a single item completed on successful send", async () => {
    const { gateway, requestRaw } = makeStubGateway();
    requestRaw.mockResolvedValue({ ok: true });

    const row = repo.enqueue({
      kind: "memory-entry",
      method: "POST",
      path: "/v1/memory/entries",
      body: { block: "semantic", content: "hi" },
      idempotencyKey: "k1",
    });

    const worker = new SyncWorker({ gateway, repo });
    const result = await worker.drainOnce();

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(requestRaw).toHaveBeenCalledTimes(1);
    expect(requestRaw).toHaveBeenCalledWith(
      "POST",
      "/v1/memory/entries",
      { block: "semantic", content: "hi" },
      "k1",
    );

    const reloaded = repo.getById(row.id);
    expect(reloaded?.status).toBe("completed");
  });

  it("drains multiple items in a single pass", async () => {
    const { gateway, requestRaw } = makeStubGateway();
    requestRaw.mockResolvedValue({ ok: true });

    for (let i = 0; i < 5; i++) {
      repo.enqueue({
        kind: "memory-entry",
        method: "POST",
        path: `/v1/memory/entries/${i}`,
        body: { i },
        idempotencyKey: `k-${i}`,
      });
    }

    const worker = new SyncWorker({ gateway, repo });
    const result = await worker.drainOnce();

    expect(result.processed).toBe(5);
    expect(result.succeeded).toBe(5);
    expect(requestRaw).toHaveBeenCalledTimes(5);
  });

  it("respects batchSize", async () => {
    const { gateway, requestRaw } = makeStubGateway();
    requestRaw.mockResolvedValue({ ok: true });

    for (let i = 0; i < 10; i++) {
      repo.enqueue({
        kind: "x",
        method: "POST",
        path: "/x",
        idempotencyKey: `k-${i}`,
      });
    }

    const worker = new SyncWorker({ gateway, repo, batchSize: 3 });
    await worker.drainOnce();

    // First pass: 3 items processed
    const stats = repo.getStats();
    expect(stats.completed).toBe(3);
    expect(stats.pending).toBe(7);
  });

  it("marks failing items for retry with backoff", async () => {
    const { gateway, requestRaw } = makeStubGateway();
    requestRaw.mockRejectedValue(new Error("network error"));

    const row = repo.enqueue({
      kind: "memory-entry",
      method: "POST",
      path: "/v1/memory/entries",
      body: { block: "semantic", content: "hi" },
      idempotencyKey: "fail-1",
    });

    const worker = new SyncWorker({ gateway, repo });
    const result = await worker.drainOnce();

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });

    const reloaded = repo.getById(row.id)!;
    expect(reloaded.status).toBe("pending"); // Retry pending, not terminal
    expect(reloaded.attemptCount).toBe(1);
    expect(reloaded.lastError).toBe("network error");
    // Next attempt is in the near future (5s + jitter)
    const now = Math.floor(Date.now() / 1000);
    expect(reloaded.nextAttemptAt).toBeGreaterThan(now);
  });

  it("does not pick up a failed item whose backoff hasn't elapsed", async () => {
    const { gateway, requestRaw } = makeStubGateway();
    requestRaw.mockRejectedValue(new Error("network error"));

    repo.enqueue({
      kind: "x",
      method: "POST",
      path: "/x",
      idempotencyKey: "k1",
    });

    const worker = new SyncWorker({ gateway, repo });
    await worker.drainOnce(); // First pass: fails, schedules retry in 5s

    requestRaw.mockClear();
    const result = await worker.drainOnce(); // Second pass: immediate, backoff not elapsed

    expect(result.processed).toBe(0);
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it("marks row as permanently failed after maxAttempts exhausted", async () => {
    const { gateway, requestRaw } = makeStubGateway();
    requestRaw.mockRejectedValue(new Error("always fails"));

    const row = repo.enqueue({
      kind: "x",
      method: "POST",
      path: "/x",
      idempotencyKey: "terminal",
      maxAttempts: 2,
    });

    const worker = new SyncWorker({ gateway, repo });
    await worker.drainOnce(); // attempt 1 → retry scheduled

    // Reset backoff so we can drain again
    db.prepare(
      "UPDATE sync_queue SET next_attempt_at = unixepoch() WHERE id = ?",
    ).run(row.id);
    await worker.drainOnce(); // attempt 2 → hits maxAttempts → terminal failed

    const reloaded = repo.getById(row.id)!;
    expect(reloaded.status).toBe("failed");
    expect(reloaded.attemptCount).toBe(2);
  });

  it("handles mixed success/failure in a single batch", async () => {
    const { gateway, requestRaw } = makeStubGateway();

    // First call succeeds, second fails, third succeeds
    requestRaw
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("middle fail"))
      .mockResolvedValueOnce({ ok: true });

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
    });

    const worker = new SyncWorker({ gateway, repo });
    const result = await worker.drainOnce();

    expect(result).toEqual({ processed: 3, succeeded: 2, failed: 1 });
    expect(repo.getById(a.id)?.status).toBe("completed");
    expect(repo.getById(b.id)?.status).toBe("pending"); // retry
    expect(repo.getById(c.id)?.status).toBe("completed");
  });

  it("passes idempotency key to gateway requestRaw", async () => {
    const { gateway, requestRaw } = makeStubGateway();
    requestRaw.mockResolvedValue({ ok: true });

    repo.enqueue({
      kind: "x",
      method: "POST",
      path: "/x",
      idempotencyKey: "unique-key-xyz",
    });

    const worker = new SyncWorker({ gateway, repo });
    await worker.drainOnce();

    expect(requestRaw).toHaveBeenCalledWith(
      "POST",
      "/x",
      undefined,
      "unique-key-xyz",
    );
  });

  it("tracks stats across multiple passes", async () => {
    const { gateway, requestRaw } = makeStubGateway();
    requestRaw.mockResolvedValue({ ok: true });

    for (let i = 0; i < 3; i++) {
      repo.enqueue({
        kind: "x",
        method: "POST",
        path: "/x",
        idempotencyKey: `k-${i}`,
      });
    }

    const worker = new SyncWorker({ gateway, repo });
    await worker.drainOnce();
    await worker.drainOnce(); // empty second pass

    const stats = worker.getStats();
    expect(stats.passesRun).toBe(2);
    expect(stats.itemsProcessed).toBe(3);
    expect(stats.itemsSucceeded).toBe(3);
    expect(stats.itemsFailed).toBe(0);
    expect(stats.lastPassAt).toBeGreaterThan(0);
  });
});
