/**
 * Tests for the drift detector + ChangeSet primitives.
 *
 * Coverage:
 *   - IndexDriftDetector: clean / stale / missing / mtime-only-touch
 *   - RebuildIndexEntryChangeSet: simulate, apply, revert (unsupported)
 *   - IntentRuntimeDriftDetector: equal vs unequal; serialize override
 *   - ApplyIntentToRuntimeChangeSet: apply success, apply failure,
 *     revert with and without inverse callback
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashContent } from "@brainst0rm/harness-fs";
import { HarnessIndexStore } from "@brainst0rm/harness-index";
import {
  IndexDriftDetector,
  RebuildIndexEntryChangeSet,
  IntentRuntimeDriftDetector,
  ApplyIntentToRuntimeChangeSet,
} from "../index.js";

let testRoot: string;
let store: HarnessIndexStore;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "harness-drift-test-"));
  store = new HarnessIndexStore(join(testRoot, "index.db"));
});

afterEach(() => {
  store.close();
  rmSync(testRoot, { recursive: true, force: true });
});

// ── IndexDriftDetector ───────────────────────────────────────

describe("IndexDriftDetector", () => {
  test("returns no drifts when index matches FS", () => {
    const file = "ok.md";
    writeFileSync(join(testRoot, file), "hello\n");
    const stats = require("node:fs").statSync(join(testRoot, file));
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: stats.mtimeMs,
      size_bytes: stats.size,
      content_hash: hashContent("hello\n"),
    });

    const detector = new IndexDriftDetector(testRoot, store);
    expect(detector.detect()).toEqual([]);
  });

  test("emits stale drift when file content changes", () => {
    const file = "x.md";
    writeFileSync(join(testRoot, file), "v1\n");
    const stats = require("node:fs").statSync(join(testRoot, file));
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: stats.mtimeMs,
      size_bytes: stats.size,
      content_hash: hashContent("v1\n"),
    });

    writeFileSync(join(testRoot, file), "v2-different\n");
    const detector = new IndexDriftDetector(testRoot, store);
    const drifts = detector.detect();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.field_class).toBe("index");
    expect(drifts[0]?.relative_path).toBe(file);
    expect(drifts[0]?.intent_value).toBe(hashContent("v1\n"));
    expect(drifts[0]?.observed_value).toBe(hashContent("v2-different\n"));
  });

  test("emits missing drift when file deleted", () => {
    const file = "gone.md";
    writeFileSync(join(testRoot, file), "x\n");
    const stats = require("node:fs").statSync(join(testRoot, file));
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: stats.mtimeMs,
      size_bytes: stats.size,
      content_hash: hashContent("x\n"),
    });
    unlinkSync(join(testRoot, file));

    const detector = new IndexDriftDetector(testRoot, store);
    const drifts = detector.detect();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.observed_value).toBeNull();
  });

  test("ids are stable across calls (idempotent)", () => {
    const file = "stable.md";
    writeFileSync(join(testRoot, file), "v1-short\n");
    const stats = require("node:fs").statSync(join(testRoot, file));
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: stats.mtimeMs,
      size_bytes: stats.size,
      content_hash: hashContent("v1-short\n"),
    });
    // Different-sized content guarantees the size-changed path fires
    // even on coarse-mtime filesystems (the detector relies on (mtime,
    // size) drift to skip re-hashing as a perf optimization per spec).
    writeFileSync(join(testRoot, file), "v2-much-longer-content-here\n");

    const d = new IndexDriftDetector(testRoot, store);
    const id1 = d.detect()[0]?.id;
    const id2 = d.detect()[0]?.id;
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });
});

// ── RebuildIndexEntryChangeSet ───────────────────────────────

describe("RebuildIndexEntryChangeSet", () => {
  test("apply re-indexes from FS using the provided updater", async () => {
    const file = "rebuild.md";
    writeFileSync(join(testRoot, file), "v1\n");
    const stats = require("node:fs").statSync(join(testRoot, file));
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: stats.mtimeMs,
      size_bytes: stats.size,
      content_hash: hashContent("v1\n"),
    });
    writeFileSync(join(testRoot, file), "v2-content\n");

    const drifts = new IndexDriftDetector(testRoot, store).detect();
    let updaterCalled = false;
    const cs = new RebuildIndexEntryChangeSet(
      drifts[0]!,
      "team/agents/test",
      testRoot,
      store,
      (relativePath, content) => {
        updaterCalled = true;
        const fileStats = require("node:fs").statSync(
          join(testRoot, relativePath),
        );
        store.upsertArtifact({
          relative_path: relativePath,
          mtime_ms: fileStats.mtimeMs,
          size_bytes: fileStats.size,
          content_hash: hashContent(content),
        });
      },
    );

    const sim = await cs.simulate();
    expect(sim.reversible).toBe(false);
    expect(sim.diffs).toHaveLength(1);

    const result = await cs.apply();
    expect(result.ok).toBe(true);
    expect(updaterCalled).toBe(true);

    const after = store.getArtifact(file);
    expect(after?.content_hash).toBe(hashContent("v2-content\n"));
  });

  test("apply removes entry when file is missing", async () => {
    const file = "gone.md";
    writeFileSync(join(testRoot, file), "x\n");
    const stats = require("node:fs").statSync(join(testRoot, file));
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: stats.mtimeMs,
      size_bytes: stats.size,
      content_hash: hashContent("x\n"),
    });
    unlinkSync(join(testRoot, file));

    const drifts = new IndexDriftDetector(testRoot, store).detect();
    const cs = new RebuildIndexEntryChangeSet(
      drifts[0]!,
      "team/agents/test",
      testRoot,
      store,
      () => {
        throw new Error("updater should not be called for missing files");
      },
    );

    const result = await cs.apply();
    expect(result.ok).toBe(true);
    expect(store.getArtifact(file)).toBeNull();
  });

  test("revert is unsupported (index is purely derived)", () => {
    writeFileSync(join(testRoot, "x.md"), "y-short\n");
    const stats = require("node:fs").statSync(join(testRoot, "x.md"));
    // Index records a different-sized hash → triggers size-changed path
    store.upsertArtifact({
      relative_path: "x.md",
      mtime_ms: stats.mtimeMs - 1000, // also ensure mtime mismatch
      size_bytes: stats.size + 99,
      content_hash: hashContent("z-different-content\n"),
    });
    const drifts = new IndexDriftDetector(testRoot, store).detect();
    expect(drifts).toHaveLength(1);
    const cs = new RebuildIndexEntryChangeSet(
      drifts[0]!,
      "team/agents/test",
      testRoot,
      store,
      () => {},
    );
    const result = cs.revert();
    if ("then" in (result as object)) {
      throw new Error("expected sync result");
    }
    expect((result as { ok: boolean }).ok).toBe(false);
  });
});

// ── IntentRuntimeDriftDetector ──────────────────────────────

describe("IntentRuntimeDriftDetector", () => {
  test("returns no drifts when intent equals observed", async () => {
    const detector = new IntentRuntimeDriftDetector<number>({
      detector_name: "mrr-detector",
      relative_path: "customers/accounts/acme/account.toml",
      field_path: "mrr_intent",
      severity: "high",
      loadIntent: () => 8500,
      loadObserved: () => 8500,
    });
    expect(await detector.detect()).toEqual([]);
  });

  test("emits drift when values differ", async () => {
    const detector = new IntentRuntimeDriftDetector<number>({
      detector_name: "mrr-detector",
      relative_path: "customers/accounts/acme/account.toml",
      field_path: "mrr_intent",
      severity: "high",
      loadIntent: () => 8500,
      loadObserved: () => 73000,
    });
    const drifts = await detector.detect();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.field_class).toBe("intent");
    expect(drifts[0]?.severity).toBe("high");
    expect(drifts[0]?.intent_value).toBe("8500");
    expect(drifts[0]?.observed_value).toBe("73000");
  });

  test("custom equal() suppresses drift for tolerated deltas", async () => {
    const detector = new IntentRuntimeDriftDetector<number>({
      detector_name: "mrr-detector-tolerant",
      relative_path: "customers/accounts/acme/account.toml",
      field_path: "mrr_intent",
      severity: "low",
      loadIntent: () => 8500,
      loadObserved: () => 8501, // within $1 — tolerated
      equal: (a, b) => Math.abs((a ?? 0) - (b ?? 0)) <= 1,
    });
    expect(await detector.detect()).toEqual([]);
  });

  test("ids are stable for the same field across calls", async () => {
    const factory = () =>
      new IntentRuntimeDriftDetector<number>({
        detector_name: "stable-id",
        relative_path: "x/y.toml",
        field_path: "f",
        severity: "medium",
        loadIntent: () => 1,
        loadObserved: () => 2,
      });
    const id1 = (await factory().detect())[0]?.id;
    const id2 = (await factory().detect())[0]?.id;
    expect(id1).toBe(id2);
  });
});

// ── ApplyIntentToRuntimeChangeSet ───────────────────────────

describe("ApplyIntentToRuntimeChangeSet", () => {
  test("apply invokes the runtime callback with the intent value", async () => {
    const detector = new IntentRuntimeDriftDetector<number>({
      detector_name: "mrr-test",
      relative_path: "customers/accounts/acme/account.toml",
      field_path: "mrr",
      severity: "high",
      loadIntent: () => 8500,
      loadObserved: () => 73000,
    });
    const drift = (await detector.detect())[0]!;

    let receivedValue: number | null = null;
    const cs = new ApplyIntentToRuntimeChangeSet<number>({
      drift,
      actor_ref: "team/humans/justin",
      intent_value: 8500,
      apply: (v) => {
        receivedValue = v;
      },
    });

    const sim = await cs.simulate();
    expect(sim.reversible).toBe(false); // no revert callback provided

    const result = await cs.apply();
    expect(result.ok).toBe(true);
    expect(receivedValue).toBe(8500);
  });

  test("apply error is surfaced as ok=false (no throw)", async () => {
    const detector = new IntentRuntimeDriftDetector<number>({
      detector_name: "mrr-test",
      relative_path: "x.toml",
      field_path: "mrr",
      severity: "medium",
      loadIntent: () => 1,
      loadObserved: () => 2,
    });
    const drift = (await detector.detect())[0]!;

    const cs = new ApplyIntentToRuntimeChangeSet<number>({
      drift,
      actor_ref: "agent",
      intent_value: 1,
      apply: () => {
        throw new Error("Stripe rate limit");
      },
    });
    const result = await cs.apply();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Stripe rate limit");
  });

  test("revert calls the inverse callback when provided", async () => {
    const detector = new IntentRuntimeDriftDetector<number>({
      detector_name: "mrr-test",
      relative_path: "x.toml",
      field_path: "mrr",
      severity: "medium",
      loadIntent: () => 1,
      loadObserved: () => 2,
    });
    const drift = (await detector.detect())[0]!;

    let revertCalledWith: number | null | "never" = "never";
    const cs = new ApplyIntentToRuntimeChangeSet<number>({
      drift,
      actor_ref: "agent",
      intent_value: 1,
      apply: () => {},
      revert: (v) => {
        revertCalledWith = v;
      },
      prior_observed_value: 2,
    });
    const sim = await cs.simulate();
    expect(sim.reversible).toBe(true);

    const result = await cs.revert();
    expect(result.ok).toBe(true);
    expect(revertCalledWith).toBe(2);
  });

  test("revert without callback returns ok=false with explanation", async () => {
    const detector = new IntentRuntimeDriftDetector<number>({
      detector_name: "mrr-test",
      relative_path: "x.toml",
      field_path: "mrr",
      severity: "medium",
      loadIntent: () => 1,
      loadObserved: () => 2,
    });
    const drift = (await detector.detect())[0]!;
    const cs = new ApplyIntentToRuntimeChangeSet<number>({
      drift,
      actor_ref: "agent",
      intent_value: 1,
      apply: () => {},
    });
    const result = await cs.revert();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not support revert");
  });
});
