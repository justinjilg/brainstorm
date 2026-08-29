/**
 * PlatformEventRepository tests.
 *
 * Pins the pushed-perception contract: events are recorded with payloads,
 * surfaced oldest-first while unconsumed, consumed exactly once (so a tick
 * never re-notices them), retained after consumption for audit, and pruned
 * only when consumed AND older than the retention window.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { getTestDb } from "../client.js";
import { PlatformEventRepository } from "../repositories.js";

let db: Database.Database;
let repo: PlatformEventRepository;

beforeEach(() => {
  db = getTestDb();
  repo = new PlatformEventRepository(db);
});

afterEach(() => {
  db.close();
});

describe("PlatformEventRepository", () => {
  it("records and reads back an event with payload", () => {
    const row = repo.record({
      source: "msp",
      eventType: "msp.alert.created",
      summary: "Disk failure predicted on host-7",
      payload: { host: "host-7", severity: "high" },
    });
    expect(row.id).toBeTruthy();
    expect(row.source).toBe("msp");
    expect(row.eventType).toBe("msp.alert.created");
    expect(row.payload).toEqual({ host: "host-7", severity: "high" });
    expect(row.consumedAt).toBeNull();
  });

  it("lists unconsumed oldest-first and respects the limit", () => {
    const a = repo.record({ source: "msp", eventType: "a" });
    const b = repo.record({ source: "vm", eventType: "b" });
    repo.record({ source: "shield", eventType: "c" });

    const twoOldest = repo.listUnconsumed(2);
    expect(twoOldest.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it("markConsumed removes events from the unconsumed list but keeps the rows", () => {
    const a = repo.record({ source: "msp", eventType: "a" });
    const b = repo.record({ source: "vm", eventType: "b" });

    repo.markConsumed([a.id]);

    expect(repo.listUnconsumed().map((e) => e.id)).toEqual([b.id]);
    // Row retained for audit with a consumption timestamp.
    const consumed = repo.getById(a.id);
    expect(consumed).not.toBeNull();
    expect(consumed!.consumedAt).not.toBeNull();
  });

  it("markConsumed with an empty batch is a no-op", () => {
    repo.record({ source: "msp", eventType: "a" });
    repo.markConsumed([]);
    expect(repo.listUnconsumed()).toHaveLength(1);
  });

  it("prune deletes only consumed events past the retention window", () => {
    const old = repo.record({ source: "msp", eventType: "old" });
    const fresh = repo.record({ source: "msp", eventType: "fresh" });
    repo.markConsumed([old.id, fresh.id]);
    // Backdate the old event past the window.
    db.prepare(
      "UPDATE platform_events SET received_at = unixepoch() - 40 * 86400 WHERE id = ?",
    ).run(old.id);
    // An unconsumed old event must survive pruning regardless of age.
    const unconsumedOld = repo.record({ source: "vm", eventType: "unseen" });
    db.prepare(
      "UPDATE platform_events SET received_at = unixepoch() - 40 * 86400 WHERE id = ?",
    ).run(unconsumedOld.id);

    const deleted = repo.prune(30);

    expect(deleted).toBe(1);
    expect(repo.getById(old.id)).toBeNull();
    expect(repo.getById(fresh.id)).not.toBeNull();
    expect(repo.getById(unconsumedOld.id)).not.toBeNull();
  });
});
