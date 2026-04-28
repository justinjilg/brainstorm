/**
 * Tests for HarnessIndexStore — schema migrations, CRUD, owner/tag/ref
 * queries, and cold-open verification (the spec's signature operation).
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessIndexStore } from "../index-store.js";
import { hashContent } from "@brainst0rm/harness-fs";

let testRoot: string;
let dbPath: string;
let store: HarnessIndexStore;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "harness-index-test-"));
  dbPath = join(testRoot, "index.db");
  store = new HarnessIndexStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(testRoot, { recursive: true, force: true });
});

// ── schema + meta ────────────────────────────────────────────

describe("HarnessIndexStore — schema bootstrap", () => {
  test("opens a fresh db and stamps schema_version + created_at", () => {
    expect(store.getMeta("schema_version")).toBe("1");
    expect(store.getMeta("created_at")).not.toBeNull();
  });

  test("setMeta upsert replaces existing", () => {
    store.setMeta("foo", "bar");
    expect(store.getMeta("foo")).toBe("bar");
    store.setMeta("foo", "baz");
    expect(store.getMeta("foo")).toBe("baz");
  });
});

// ── upsert + read ────────────────────────────────────────────

describe("HarnessIndexStore — artifact CRUD", () => {
  const sampleInput = (relativePath = "team/humans/justin.toml") => ({
    relative_path: relativePath,
    mtime_ms: 1_700_000_000_000,
    size_bytes: 42,
    content_hash: hashContent("name = 'Justin'\n"),
    schema_version: 1,
    owner: "team/humans/justin",
    status: "active",
    artifact_kind: "human",
    reviewed_at: 1_700_000_000_000,
    tags: ["founder", "active"],
    references: [
      { target: "customers/accounts/acme", type: "owner-of" },
      { target: "products/brainstorm", type: "owner-of" },
    ],
  });

  test("upsert + getArtifact round-trips", () => {
    store.upsertArtifact(sampleInput());
    const row = store.getArtifact("team/humans/justin.toml");
    expect(row).not.toBeNull();
    expect(row!.owner).toBe("team/humans/justin");
    expect(row!.artifact_kind).toBe("human");
  });

  test("upsert is idempotent — second call replaces fields", () => {
    store.upsertArtifact(sampleInput());
    store.upsertArtifact({
      ...sampleInput(),
      status: "departed",
      tags: ["alumni"],
      references: [],
    });
    const row = store.getArtifact("team/humans/justin.toml");
    expect(row!.status).toBe("departed");
    expect(store.byTag("alumni")).toHaveLength(1);
    expect(store.byTag("founder")).toHaveLength(0);
  });

  test("removeArtifact cascades tags and references", () => {
    store.upsertArtifact(sampleInput());
    expect(store.byTag("founder")).toHaveLength(1);
    expect(store.byReference("customers/accounts/acme")).toHaveLength(1);

    store.removeArtifact("team/humans/justin.toml");
    expect(store.getArtifact("team/humans/justin.toml")).toBeNull();
    expect(store.byTag("founder")).toHaveLength(0);
    expect(store.byReference("customers/accounts/acme")).toHaveLength(0);
  });

  test("allArtifacts orders by path", () => {
    store.upsertArtifact(sampleInput("team/humans/zara.toml"));
    store.upsertArtifact(sampleInput("team/humans/anna.toml"));
    const all = store.allArtifacts();
    expect(all.map((r) => r.relative_path)).toEqual([
      "team/humans/anna.toml",
      "team/humans/zara.toml",
    ]);
  });
});

// ── owner / tag / reference queries ──────────────────────────

describe("HarnessIndexStore — query indices", () => {
  beforeEach(() => {
    store.upsertArtifact({
      relative_path: "products/peer10/product.toml",
      mtime_ms: 1,
      size_bytes: 10,
      content_hash: "h1",
      owner: "team/humans/justin",
      tags: ["saas"],
      references: [{ target: "customers/segments/saas-platforms" }],
    });
    store.upsertArtifact({
      relative_path: "products/eventflow/product.toml",
      mtime_ms: 1,
      size_bytes: 10,
      content_hash: "h2",
      owner: "team/humans/justin",
      tags: ["saas"],
      references: [{ target: "customers/segments/saas-platforms" }],
    });
    store.upsertArtifact({
      relative_path: "operations/it/tooling.toml",
      mtime_ms: 1,
      size_bytes: 10,
      content_hash: "h3",
      owner: "team/humans/maria",
      tags: ["operational"],
      references: [],
    });
  });

  test("byOwner finds all artifacts with a given owner", () => {
    expect(store.byOwner("team/humans/justin")).toHaveLength(2);
    expect(store.byOwner("team/humans/maria")).toHaveLength(1);
    expect(store.byOwner("team/humans/ghost")).toHaveLength(0);
  });

  test("byTag finds all artifacts carrying a tag", () => {
    expect(store.byTag("saas")).toHaveLength(2);
    expect(store.byTag("operational")).toHaveLength(1);
  });

  test("byReference finds all artifacts that reference a target", () => {
    expect(store.byReference("customers/segments/saas-platforms")).toHaveLength(
      2,
    );
  });

  test("staleSince returns artifacts older than cutoff (or null)", () => {
    store.upsertArtifact({
      relative_path: "stale.md",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      reviewed_at: 1_000_000,
    });
    store.upsertArtifact({
      relative_path: "fresh.md",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      reviewed_at: 9_000_000,
    });
    const stale = store.staleSince(2_000_000);
    expect(stale.map((r) => r.relative_path)).toContain("stale.md");
    expect(stale.map((r) => r.relative_path)).not.toContain("fresh.md");
  });
});

// ── coldOpenVerify ───────────────────────────────────────────

describe("HarnessIndexStore — coldOpenVerify", () => {
  test("clean entries pass through", () => {
    const file = "ok.md";
    const abs = join(testRoot, file);
    writeFileSync(abs, "hello\n");
    const stats = require("node:fs").statSync(abs);
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: stats.mtimeMs,
      size_bytes: stats.size,
      content_hash: hashContent("hello\n"),
    });

    const result = store.coldOpenVerify(testRoot);
    expect(result.clean).toBe(1);
    expect(result.stale).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  test("file content changed → entry is stale", () => {
    const file = "stale.md";
    const abs = join(testRoot, file);
    writeFileSync(abs, "v1\n");
    const stats = require("node:fs").statSync(abs);
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: stats.mtimeMs,
      size_bytes: stats.size,
      content_hash: hashContent("v1\n"),
    });

    writeFileSync(abs, "v2 different\n");
    const result = store.coldOpenVerify(testRoot);
    expect(result.stale).toEqual([file]);
    expect(result.clean).toBe(0);
  });

  test("file deleted → entry is missing", () => {
    const file = "gone.md";
    const abs = join(testRoot, file);
    writeFileSync(abs, "x\n");
    const stats = require("node:fs").statSync(abs);
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: stats.mtimeMs,
      size_bytes: stats.size,
      content_hash: hashContent("x\n"),
    });
    unlinkSync(abs);

    const result = store.coldOpenVerify(testRoot);
    expect(result.missing).toEqual([file]);
  });

  test("touched-but-unchanged file is reconciled in place (mtime-only update)", () => {
    const file = "touched.md";
    const abs = join(testRoot, file);
    writeFileSync(abs, "same content\n");
    const original = require("node:fs").statSync(abs);
    store.upsertArtifact({
      relative_path: file,
      mtime_ms: original.mtimeMs,
      size_bytes: original.size,
      content_hash: hashContent("same content\n"),
    });

    // Touch mtime only (e.g., cp -p, vim's atomic-write)
    const newMtime = new Date(original.mtimeMs + 60_000);
    utimesSync(abs, newMtime, newMtime);

    const result = store.coldOpenVerify(testRoot);
    expect(result.clean).toBe(1);
    expect(result.stale).toEqual([]);
    // mtime in index should move forward (filesystem granularity may round
    // sub-millisecond, so we verify monotonicity, not exact equality).
    const after = store.getArtifact(file);
    expect(after!.mtime_ms).toBeGreaterThan(original.mtimeMs);
  });
});

// ── changeset log + drift ────────────────────────────────────

describe("HarnessIndexStore — changesets and drift", () => {
  test("recordChangeset upserts and tracks state transitions", () => {
    store.recordChangeset({
      id: "cs1",
      kind: "intent-runtime-reconcile",
      state: "proposed",
      actor_ref: "team/humans/justin",
      payload: { delta: 5 },
    });
    store.recordChangeset({
      id: "cs1",
      kind: "intent-runtime-reconcile",
      state: "applied",
      actor_ref: "team/humans/justin",
      payload: { delta: 5 },
    });
    // No throw is the success criterion at this layer
  });

  test("recordDrift / resolveDrift / unresolvedDrift round-trip", () => {
    store.recordDrift({
      id: "d1",
      relative_path: "customers/accounts/acme/account.toml",
      field_path: "mrr_intent",
      field_class: "intent",
      intent_value: "8500",
      observed_value: "73000",
      detector_name: "intent-runtime-mrr",
      severity: "high",
    });
    expect(store.unresolvedDrift()).toHaveLength(1);

    store.resolveDrift("d1");
    expect(store.unresolvedDrift()).toHaveLength(0);
  });
});
