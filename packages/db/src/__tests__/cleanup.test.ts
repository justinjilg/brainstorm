import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { getTestDb, cleanupOldRecords } from "../index.js";

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - 91 * 24 * 60 * 60; // older than the 90-day cutoff
const RECENT = NOW - 7 * 24 * 60 * 60; // within the cutoff

describe("cleanupOldRecords", () => {
  test("deletes sessions older than 90 days using created_at", () => {
    db = getTestDb();

    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at, project_path) VALUES (?, ?, ?, ?)",
    ).run("old-session", OLD, OLD, "/tmp/a");
    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at, project_path) VALUES (?, ?, ?, ?)",
    ).run("fresh-session", RECENT, RECENT, "/tmp/b");

    cleanupOldRecords(db);

    const surviving = db
      .prepare("SELECT id FROM sessions ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(surviving.map((r) => r.id)).toEqual(["fresh-session"]);
  });

  test("cascades to messages of deleted sessions", () => {
    db = getTestDb();

    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at, project_path) VALUES (?, ?, ?, ?)",
    ).run("old", OLD, OLD, "/tmp");
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    ).run("m1", "old", "user", "hello", OLD);

    cleanupOldRecords(db);

    const msgs = db.prepare("SELECT id FROM messages").all();
    expect(msgs).toEqual([]);
  });

  test("preserves records inside the cutoff window", () => {
    db = getTestDb();
    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at, project_path) VALUES (?, ?, ?, ?)",
    ).run("recent", RECENT, RECENT, "/tmp");

    cleanupOldRecords(db);

    const rows = db.prepare("SELECT id FROM sessions").all() as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(["recent"]);
  });

  test("tolerates a missing table without aborting the batch", () => {
    db = getTestDb();
    // Drop one of the expected tables to simulate a schema mid-migration.
    db.prepare("DROP TABLE audit_log").run();

    db.prepare(
      "INSERT INTO sessions (id, created_at, updated_at, project_path) VALUES (?, ?, ?, ?)",
    ).run("old", OLD, OLD, "/tmp");

    // Should not throw; should still prune the session despite audit_log
    // being gone.
    expect(() => cleanupOldRecords(db!)).not.toThrow();
    const rows = db.prepare("SELECT id FROM sessions").all();
    expect(rows).toEqual([]);
  });
});

test("v17 Auditor: routing_audit rows older than 90 days are cleaned up", () => {
  db = getTestDb();
  // Seed 4 rows spanning fresh / boundary / old
  db.prepare(
    `INSERT INTO routing_audit (request_id, audit_hash, captured_at)
       VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
  ).run(
    "fresh-1",
    "0".repeat(64),
    NOW - 1 * 86400,
    "boundary-just-inside",
    "1".repeat(64),
    NOW - 89 * 86400,
    "boundary-just-outside",
    "2".repeat(64),
    NOW - 91 * 86400,
    "ancient",
    "3".repeat(64),
    NOW - 365 * 86400,
  );

  const before = (
    db.prepare("SELECT COUNT(*) as n FROM routing_audit").get() as { n: number }
  ).n;
  expect(before).toBe(4);

  cleanupOldRecords(db);

  const after = (
    db.prepare("SELECT COUNT(*) as n FROM routing_audit").get() as { n: number }
  ).n;
  expect(
    after,
    "exactly the 2 fresh + boundary-inside rows should remain",
  ).toBe(2);

  const survivors = db
    .prepare("SELECT request_id FROM routing_audit ORDER BY request_id")
    .all() as Array<{ request_id: string }>;
  const ids = survivors.map((r) => r.request_id).sort();
  expect(ids).toEqual(["boundary-just-inside", "fresh-1"]);
});
