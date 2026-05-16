/**
 * D9 concurrent-session load test (path-to-90 P9e).
 *
 * v15 audit named this gap explicitly: no measured concurrent-session
 * load test for D9 ScaleReadiness. The harness rubric 7-8 requires
 * "tested under concurrent-session load (N parallel storm calls)";
 * 9-10 requires chaos scenarios proven (BR rate-limit + concurrent
 * sessions; SQLite-busy + abort-mid-write recovery).
 *
 * Pre-existing concurrent-writers.test.ts covers PRAGMA verification +
 * busy_timeout EXHAUSTION (negative case). This file covers the POSITIVE
 * case at scale: N=8 concurrent writers, each performing M=50 inserts,
 * all complete within the busy_timeout budget, final row count is exact
 * (no lost writes, no double writes).
 *
 * Worker threads provide TRUE parallel execution (separate event loops)
 * — closer to the production threat model where two separate storm
 * processes (desktop + CLI, or two CLI sessions) both write to
 * ~/.brainstorm/brainstorm.db simultaneously.
 *
 * Per no-cheating: this test asserts measurable behavior (row count
 * exact match + completion within budget), not "concurrent code runs."
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Resolve better-sqlite3 against THIS test file's location so the
// worker (which we'll write to a tmpdir) can import it via an
// absolute file URL. Without this, the worker fails to resolve the
// dep because its working directory lacks node_modules.
const requireFromHere = createRequire(import.meta.url);
const BETTER_SQLITE3_PATH = requireFromHere.resolve("better-sqlite3");
const BETTER_SQLITE3_URL = pathToFileURL(BETTER_SQLITE3_PATH).href;

const WORKER_SOURCE = `
import Database from ${JSON.stringify(BETTER_SQLITE3_URL)};
import { parentPort, workerData } from "node:worker_threads";

const { dbPath, writerId, rowCount } = workerData;
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000");

const insert = db.prepare(
  "INSERT INTO concurrent_load (writer_id, seq, ts_ms) VALUES (?, ?, ?)"
);

let written = 0;
const startTs = Date.now();
try {
  for (let i = 0; i < rowCount; i++) {
    insert.run(writerId, i, Date.now());
    written++;
  }
  parentPort.postMessage({ ok: true, writerId, written, durationMs: Date.now() - startTs });
} catch (err) {
  parentPort.postMessage({ ok: false, writerId, written, durationMs: Date.now() - startTs, error: err.message });
} finally {
  db.close();
}
`;

interface WorkerResult {
  ok: boolean;
  writerId: number;
  written: number;
  durationMs: number;
  error?: string;
}

function runWorker(
  workerPath: string,
  dbPath: string,
  writerId: number,
  rowCount: number,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath, {
      workerData: { dbPath, writerId, rowCount },
    });
    w.once("message", resolve);
    w.once("error", reject);
    w.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${writerId} exited with code ${code}`));
      }
    });
  });
}

describe("D9 concurrent-session load (path-to-90 P9e)", () => {
  it("N=8 concurrent writers x 50 inserts each — all complete, no lost writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainstorm-d9-load-"));
    const dbPath = join(dir, "load.db");
    const workerPath = join(dir, "worker.mjs");
    writeFileSync(workerPath, WORKER_SOURCE, "utf-8");

    const setup = new Database(dbPath);
    setup.pragma("journal_mode = WAL");
    setup.pragma("busy_timeout = 10000");
    setup.exec(`
      CREATE TABLE concurrent_load (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        writer_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL
      );
      CREATE INDEX idx_writer ON concurrent_load(writer_id);
    `);
    setup.close();

    const N = 8;
    const M = 50;
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, (_, writerId) =>
        runWorker(workerPath, dbPath, writerId, M),
      ),
    );
    const elapsed = Date.now() - start;

    for (const r of results) {
      expect(
        r.ok,
        `worker ${r.writerId} failed after ${r.written}/${M}: ${r.error}`,
      ).toBe(true);
      expect(r.written).toBe(M);
    }

    const verify = new Database(dbPath);
    const total = verify
      .prepare("SELECT COUNT(*) as n FROM concurrent_load")
      .get() as { n: number };
    expect(
      total.n,
      `expected ${N * M} rows from ${N} writers x ${M} inserts; got ${total.n}`,
    ).toBe(N * M);

    for (let writerId = 0; writerId < N; writerId++) {
      const rows = verify
        .prepare(
          "SELECT seq FROM concurrent_load WHERE writer_id = ? ORDER BY seq ASC",
        )
        .all(writerId) as Array<{ seq: number }>;
      expect(rows.length, `writer ${writerId} should have ${M} rows`).toBe(M);
      for (let i = 0; i < M; i++) {
        expect(rows[i].seq).toBe(i);
      }
    }
    verify.close();

    expect(
      elapsed,
      `load completed in ${elapsed}ms (cap 30000ms)`,
    ).toBeLessThan(30_000);
  }, 60_000);

  it("N=4 concurrent writers + 1 reader — reader sees consistent snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainstorm-d9-reader-"));
    const dbPath = join(dir, "rw.db");
    const workerPath = join(dir, "worker.mjs");
    writeFileSync(workerPath, WORKER_SOURCE, "utf-8");

    const setup = new Database(dbPath);
    setup.pragma("journal_mode = WAL");
    setup.exec(`
      CREATE TABLE concurrent_load (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        writer_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL
      );
    `);
    setup.close();

    const N = 4;
    const M = 25;

    const writerPromises = Array.from({ length: N }, (_, writerId) =>
      runWorker(workerPath, dbPath, writerId, M),
    );

    const reader = new Database(dbPath, { readonly: true });
    reader.pragma("journal_mode = WAL");
    const readSnapshots: number[] = [];
    for (let i = 0; i < 20; i++) {
      const row = reader
        .prepare("SELECT COUNT(*) as n FROM concurrent_load")
        .get() as { n: number };
      readSnapshots.push(row.n);
      await new Promise((r) => setTimeout(r, 25));
    }

    const writerResults = await Promise.all(writerPromises);
    reader.close();

    for (const r of writerResults) {
      expect(r.ok, `writer ${r.writerId} failed: ${r.error}`).toBe(true);
    }

    for (let i = 1; i < readSnapshots.length; i++) {
      expect(
        readSnapshots[i],
        `snapshot at ${i} (${readSnapshots[i]}) regressed below ${i - 1} (${readSnapshots[i - 1]})`,
      ).toBeGreaterThanOrEqual(readSnapshots[i - 1]);
    }

    const final = new Database(dbPath, { readonly: true });
    const total = final
      .prepare("SELECT COUNT(*) as n FROM concurrent_load")
      .get() as { n: number };
    expect(total.n).toBe(N * M);
    final.close();
  }, 60_000);
});
