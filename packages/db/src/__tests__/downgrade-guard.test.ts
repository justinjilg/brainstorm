/**
 * P8d downgrade guard — assertNoUnknownMigrations.
 *
 * Scenario: a 0.14 CLI applied migration "099_future_thing" to the
 * shared ~/.brainstorm/brainstorm.db. The user then `npm install -g
 * @brainst0rm/cli@0.13.0` to roll back. The 0.13 build's
 * runMigrations() must NOT silently proceed — older code reading
 * the new schema can mishandle NOT NULL columns it doesn't
 * populate. Per docs/runbooks/rollback-published-version.md the
 * expected behaviour is fail-fast with a pointer to the runbook.
 *
 * better-sqlite3 is sync so we use the in-process DB factory rather
 * than file-on-disk to keep the test fast and isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { assertNoUnknownMigrations, getTestDb } from "../client.js";

function makeMigrationsTable(): Database.Database {
  const db = new Database(":memory:");
  // Create the _migrations table directly so we can seed the unknown
  // row BEFORE the guard runs. getTestDb's :memory: shares no state
  // across calls so we can't seed-then-reopen with it.
  db.prepare(
    "CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))",
  ).run();
  return db;
}

describe("downgrade guard (P8d)", () => {
  const originalEnv = process.env.BRAINSTORM_DB_ALLOW_UNKNOWN_MIGRATIONS;
  beforeEach(() => {
    delete process.env.BRAINSTORM_DB_ALLOW_UNKNOWN_MIGRATIONS;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BRAINSTORM_DB_ALLOW_UNKNOWN_MIGRATIONS;
    } else {
      process.env.BRAINSTORM_DB_ALLOW_UNKNOWN_MIGRATIONS = originalEnv;
    }
  });

  it("no rows → returns without throwing (fresh install)", () => {
    const db = makeMigrationsTable();
    const known = new Set(["001_a", "002_b"]);
    expect(() => assertNoUnknownMigrations(db, known)).not.toThrow();
  });

  it("all rows in known set → returns without throwing (matched CLI)", () => {
    const db = makeMigrationsTable();
    db.prepare("INSERT INTO _migrations (name) VALUES (?), (?)").run(
      "001_a",
      "002_b",
    );
    const known = new Set(["001_a", "002_b", "003_c"]);
    expect(() => assertNoUnknownMigrations(db, known)).not.toThrow();
  });

  it("seeded unknown migration → throws with runbook pointer (downgrade detected)", () => {
    const db = makeMigrationsTable();
    db.prepare("INSERT INTO _migrations (name) VALUES (?), (?)").run(
      "001_a",
      "099_from_a_newer_cli",
    );
    const known = new Set(["001_a", "002_b"]);
    let caught: unknown;
    try {
      assertNoUnknownMigrations(db, known);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain("099_from_a_newer_cli");
    expect(msg).toContain("rollback-published-version.md");
    expect(msg).toContain("BRAINSTORM_DB_ALLOW_UNKNOWN_MIGRATIONS");
  });

  it("escape hatch BRAINSTORM_DB_ALLOW_UNKNOWN_MIGRATIONS=1 → no throw", () => {
    const db = makeMigrationsTable();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(
      "099_future_with_hatch",
    );
    process.env.BRAINSTORM_DB_ALLOW_UNKNOWN_MIGRATIONS = "1";
    const known = new Set(["001_a"]);
    expect(() => assertNoUnknownMigrations(db, known)).not.toThrow();
  });

  it("any other env value does NOT trigger the escape hatch", () => {
    const db = makeMigrationsTable();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(
      "099_future_strict",
    );
    process.env.BRAINSTORM_DB_ALLOW_UNKNOWN_MIGRATIONS = "true";
    const known = new Set(["001_a"]);
    expect(() => assertNoUnknownMigrations(db, known)).toThrow(
      /099_future_strict/,
    );
  });

  it("multiple unknown rows are all listed in the error message", () => {
    const db = makeMigrationsTable();
    db.prepare("INSERT INTO _migrations (name) VALUES (?), (?), (?)").run(
      "098_a_future",
      "099_b_future",
      "100_c_future",
    );
    const known = new Set<string>();
    let caught: unknown;
    try {
      assertNoUnknownMigrations(db, known);
    } catch (err) {
      caught = err;
    }
    const msg = (caught as Error).message;
    expect(msg).toContain("098_a_future");
    expect(msg).toContain("099_b_future");
    expect(msg).toContain("100_c_future");
  });

  it("real production path: getTestDb works without unknown migrations", () => {
    // Sanity that the guard doesn't break the happy path.
    const db = getTestDb();
    const count = db.prepare("SELECT COUNT(*) as n FROM _migrations").get() as {
      n: number;
    };
    expect(count.n).toBeGreaterThan(0);
  });
});
