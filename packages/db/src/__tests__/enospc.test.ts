/**
 * ENOSPC (disk full) trap.
 *
 * Chaos Monkey's 3-round ask (v9/v11/v12): the WAL-recovery trap
 * covers truncated journal files, but nothing locks in what happens
 * when a WRITE hits a full disk in production. The real scenario:
 * user's laptop fills up during a memory-save / session-insert /
 * audit-log append. If better-sqlite3's SQLITE_FULL error shape
 * changes across a version bump, `isDbError()` in
 * packages/core/src/agent/loop.ts:98 — which keys on
 * `err.code === "SQLITE_FULL"` — would silently stop matching and
 * the loop's retry/classification would treat disk-full as a
 * generic error (wrong category, wrong user-facing message).
 *
 * Simulation approach: `PRAGMA max_page_count = N` caps the DB file
 * size at N pages (~4KB each), so writes that would grow the file
 * past the cap return SQLITE_FULL — the EXACT error code an ENOSPC
 * disk would surface, without the test touching the real filesystem
 * or requiring a tmpfs mount.
 *
 * What the trap verifies:
 *   1. better-sqlite3 throws a SqliteError when the write quota is hit
 *   2. err.code === "SQLITE_FULL" (contract for loop.ts's classifier)
 *   3. The DB remains queryable after the error — no corruption, no
 *      silent data loss of rows committed before the cap was reached
 *   4. After the cap is lifted, writes resume normally
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeTempDb(): { path: string; db: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), "brainstorm-enospc-trap-"));
  const path = join(dir, "test.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.prepare(
    "CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)",
  ).run();
  return { path, db };
}

describe("SQLite disk-full (ENOSPC) recovery", () => {
  it("throws SqliteError with code SQLITE_FULL when write quota is exceeded", () => {
    const { db } = makeTempDb();

    // Tiny page budget — just a few pages beyond the schema/headers
    // the CREATE TABLE already consumed. 10 pages × 4KB = ~40KB, so
    // ~dozens of inserts fit before SQLITE_FULL fires.
    db.pragma("max_page_count = 10");

    const insert = db.prepare("INSERT INTO logs (payload) VALUES (?)");
    // Each payload ~1KB, forcing page growth quickly.
    const payload = "x".repeat(1024);

    let thrown: any = null;
    try {
      // Cap at 1000 inserts so a misconfigured test doesn't run forever
      // if the budget never trips. In practice SQLITE_FULL fires in
      // dozens of inserts at max_page_count=10.
      for (let i = 0; i < 1000; i++) {
        insert.run(payload);
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown, "writes never hit the quota — test misconfigured").not.toBe(
      null,
    );
    // better-sqlite3 errors expose .code for the SQLite extended result
    // code; "SQLITE_FULL" is what the ENOSPC disk and the page-quota
    // paths BOTH surface. loop.ts:98 matches on this literal string.
    expect(thrown.code).toBe("SQLITE_FULL");
    // Defensive: a future library version might rename/class-swap but
    // still carry "full" in the message — the classifier has a fallback
    // substring check in loop.ts:104 ("no space left"). Confirm the
    // primary contract first, the fallback second.
    expect(String(thrown.message).toLowerCase()).toMatch(/full|no space|disk/);

    db.close();
  });

  it("DB is still queryable after hitting the write quota", () => {
    // Silent data loss of previously-committed rows is the regression
    // we cannot afford — if a user hits ENOSPC mid-session, their
    // history before the crash must still be readable.
    const { db } = makeTempDb();

    db.pragma("max_page_count = 10");
    const insert = db.prepare("INSERT INTO logs (payload) VALUES (?)");

    let committed = 0;
    try {
      for (let i = 0; i < 1000; i++) {
        insert.run("x".repeat(1024));
        committed++;
      }
    } catch {
      // Quota hit — expected.
    }

    expect(
      committed,
      "should have committed SOME rows before quota",
    ).toBeGreaterThan(0);

    // The DB is still usable — a SELECT right after SQLITE_FULL must
    // succeed and must return every row that committed pre-quota.
    const rows = db.prepare("SELECT COUNT(*) AS c FROM logs").get() as {
      c: number;
    };
    expect(rows.c).toBe(committed);

    db.close();
  });

  it("writes resume normally after quota is lifted", () => {
    // Simulates "user frees up disk space, app keeps running" — the
    // DB shouldn't need a reopen to recover. Pre-fix, if SQLITE_FULL
    // left some lock/pragma state broken, the next write would fail
    // even after the cap lifts.
    const { db } = makeTempDb();
    db.pragma("max_page_count = 10");
    const insert = db.prepare("INSERT INTO logs (payload) VALUES (?)");

    let errored = false;
    try {
      for (let i = 0; i < 1000; i++) {
        insert.run("x".repeat(1024));
      }
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);

    // Lift the cap (user freed disk) — raise to 10000 pages.
    db.pragma("max_page_count = 10000");

    // A single tiny insert should now succeed.
    expect(() => insert.run("small")).not.toThrow();
    const rows = db.prepare("SELECT COUNT(*) AS c FROM logs").get() as {
      c: number;
    };
    expect(rows.c).toBeGreaterThan(0);

    db.close();
  });
});
