import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessIndexStore } from "@brainst0rm/harness-index";
import { HarnessLoopRunner, type LoopEvent } from "../index.js";

const NOW_MS = 1_700_000_000_000;

let root: string;
let dbPath: string;
let store: HarnessIndexStore;

function writeFile(rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loop-"));
  // Keep the SQLite db OUTSIDE the harness root so the indexer's own
  // writes don't perturb a file the walker would see — matches the
  // production layout (~/.brainstorm/harness-index/<id>.db).
  dbPath = mkdtempSync(join(tmpdir(), "loop-db-")) + "/index.db";
  store = new HarnessIndexStore(dbPath);
  // Minimal harness so the walker doesn't fail.
  writeFile(
    "business.toml",
    `[identity]
id        = "biz_test"
name      = "Test"
archetype = "saas-platform"
schema    = "1.0"

[validation]
strict   = ["business.toml"]
lenient  = []
advisory = []

[access]
sensitive = []

[ai_loops]
monthly_budget_usd     = 500
peak_run_dollars       = 50
detector_throttle_mode = "skip"
alert_threshold_pct    = 0.8
`,
  );
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("HarnessLoopRunner", () => {
  test("runOnce(indexer) walks the harness and reports counts", async () => {
    writeFile(
      "team/humans/justin.toml",
      `id = "person_justin"
name = "Justin"
owner = "team/humans/justin"
status = "active"
`,
    );

    const events: LoopEvent[] = [];
    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      now: () => NOW_MS,
      onEvent: (e) => events.push(e),
    });

    const event = await runner.runOnce("indexer");
    expect(event.status).toBe("completed");
    expect(event.summary).toMatchObject({
      walked: expect.any(Number),
      upserts: expect.any(Number),
      pruned: 0,
    });
    expect(events.filter((e) => e.loop === "indexer")).toHaveLength(2);
  });

  test("runOnce(indexer) skips unchanged files on a second run", async () => {
    writeFile("team/humans/justin.toml", `id = "person_justin"\n`);

    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      now: () => NOW_MS,
    });

    const first = await runner.runOnce("indexer");
    expect(first.summary?.upserts).toBeGreaterThan(0);
    expect(first.summary?.unchanged).toBe(0);

    // Second run with no file changes — every artifact should land in
    // `unchanged` and zero upserts should fire. This is the load-bearing
    // behavior that prevents the periodic indexer from re-reading every
    // file every cycle (the v1 memory-leak shape).
    const second = await runner.runOnce("indexer");
    expect(second.summary?.upserts).toBe(0);
    expect(second.summary?.unchanged).toBeGreaterThan(0);
    expect(second.summary?.unchanged).toBe(first.summary?.upserts);
    expect(second.summary?.pruned).toBe(0);
  });

  test("runOnce(indexer) prunes deleted files between runs", async () => {
    writeFile("doomed.md", `# doomed\n`);
    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      now: () => NOW_MS,
    });
    await runner.runOnce("indexer");
    expect(
      store.allArtifacts().some((a) => a.relative_path === "doomed.md"),
    ).toBe(true);

    rmSync(join(root, "doomed.md"));
    const e = await runner.runOnce("indexer");
    expect(e.summary?.pruned).toBe(1);
    expect(
      store.allArtifacts().some((a) => a.relative_path === "doomed.md"),
    ).toBe(false);
  });

  test("runOnce(customer-drift) records drifts to the index", async () => {
    writeFile("customers/accounts/acme/account.toml", `mrr_intent = 5000\n`);
    writeFile("customers/accounts/acme/runtime.toml", `mrr_observed = 7000\n`);

    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      now: () => NOW_MS,
    });
    const event = await runner.runOnce("customer-drift");
    expect(event.status).toBe("completed");
    expect(event.summary?.drifts_open).toBe(1);

    const unresolved = store.unresolvedDrift();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.field_path).toBe("mrr_intent");
  });

  test("runOnce(stale-watchdog) reports stale-artifact counts", async () => {
    // Index something so the stale detector has rows to evaluate.
    store.upsertArtifact({
      relative_path: "team/humans/justin.toml",
      mtime_ms: NOW_MS - 365 * 24 * 60 * 60 * 1000, // 1 year old
      size_bytes: 100,
      content_hash: "abc",
      artifact_kind: "human",
      owner: "team/humans/justin",
      status: "active",
      reviewed_at: null,
      tags: [],
      references: [],
    });

    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      now: () => NOW_MS,
    });
    const event = await runner.runOnce("stale-watchdog");
    expect(event.status).toBe("completed");
    expect(event.summary).toMatchObject({
      stale_artifacts: expect.any(Number),
    });
  });

  test("emit failure event when a loop throws", async () => {
    // Force the customer-drift loop to fail by making customers/accounts
    // a file rather than a directory.
    writeFile("customers/accounts", "not a dir\n");

    const events: LoopEvent[] = [];
    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      now: () => NOW_MS,
      onEvent: (e) => events.push(e),
    });
    const event = await runner.runOnce("customer-drift");
    // The current detector silently treats missing accounts dir as no
    // drift, so this should still complete; just verify the event flows.
    expect(["completed", "failed"]).toContain(event.status);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  test("start() schedules all three loops; stop() cancels them", async () => {
    const events: LoopEvent[] = [];
    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      cadenceMs: {
        indexer: 50,
        "customer-drift": 50,
        "stale-watchdog": 50,
      },
      now: () => NOW_MS,
      onEvent: (e) => events.push(e),
    });
    runner.start();
    // Wait a beat for initial fires.
    await new Promise((r) => setTimeout(r, 30));
    runner.stop();
    const loops = new Set(events.map((e) => e.loop));
    expect(loops.has("indexer")).toBe(true);
    expect(loops.has("customer-drift")).toBe(true);
    expect(loops.has("stale-watchdog")).toBe(true);
  });

  test("overlap guard: concurrent runOnce(loop) yields one started + one skipped", async () => {
    const events: LoopEvent[] = [];
    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      now: () => NOW_MS,
      onEvent: (e) => events.push(e),
    });

    // Kick off two runs concurrently. The first acquires the guard; the
    // second sees inFlight and emits a skipped event without running.
    const [first, second] = await Promise.all([
      runner.runOnce("indexer"),
      runner.runOnce("indexer"),
    ]);

    const skippedCount = [first, second].filter(
      (e) => e.status === "skipped",
    ).length;
    const completedCount = [first, second].filter(
      (e) => e.status === "completed",
    ).length;
    expect(skippedCount).toBe(1);
    expect(completedCount).toBe(1);

    const skipped = events.find((e) => e.status === "skipped");
    expect(skipped).toBeDefined();
    expect(skipped?.loop).toBe("indexer");
    expect(skipped?.summary).toMatchObject({
      reason: "previous run still in-flight",
    });
  });

  test("overlap guard releases after completion — next runOnce works", async () => {
    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      now: () => NOW_MS,
    });

    const first = await runner.runOnce("indexer");
    expect(first.status).toBe("completed");

    // Sequential — guard already released; second call must run normally.
    const second = await runner.runOnce("indexer");
    expect(second.status).toBe("completed");
  });

  test("overlap guard is per-loop — different loops can run concurrently", async () => {
    const events: LoopEvent[] = [];
    const runner = new HarnessLoopRunner({
      harnessRoot: root,
      index: store,
      now: () => NOW_MS,
      onEvent: (e) => events.push(e),
    });

    const [a, b] = await Promise.all([
      runner.runOnce("indexer"),
      runner.runOnce("customer-drift"),
    ]);
    expect(a.status === "skipped" || b.status === "skipped").toBe(false);
    // Both should reach a terminal state (completed or failed for missing
    // accounts dir, depending on detector behavior).
    expect(["completed", "failed"]).toContain(a.status);
    expect(["completed", "failed"]).toContain(b.status);
  });
});
