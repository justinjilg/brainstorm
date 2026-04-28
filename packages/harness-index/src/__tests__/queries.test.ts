/**
 * Tests for the convenience query helpers — owner/reference/tag/stale/
 * dashboard. Each helper is a thin shim over the underlying store; tests
 * verify the shape and ordering they return.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessIndexStore } from "../index-store.js";
import {
  ownerIndex,
  referenceGraph,
  tagCloud,
  staleArtifacts,
  listParties,
  dashboardSummary,
} from "../queries.js";

let testRoot: string;
let store: HarnessIndexStore;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "queries-test-"));
  store = new HarnessIndexStore(join(testRoot, "x.db"));

  store.upsertArtifact({
    relative_path: "team/humans/justin.toml",
    mtime_ms: 1,
    size_bytes: 1,
    content_hash: "h",
    owner: "team/humans/justin",
    artifact_kind: "human",
    tags: ["founder", "active"],
    references: [],
  });
  store.upsertArtifact({
    relative_path: "products/peer10/product.toml",
    mtime_ms: 1,
    size_bytes: 1,
    content_hash: "h",
    owner: "team/humans/justin",
    artifact_kind: "product",
    tags: ["saas", "active"],
    references: [{ target: "customers/segments/saas-platforms" }],
  });
  store.upsertArtifact({
    relative_path: "products/eventflow/product.toml",
    mtime_ms: 1,
    size_bytes: 1,
    content_hash: "h",
    owner: "team/humans/justin",
    artifact_kind: "product",
    tags: ["saas"],
    references: [{ target: "customers/segments/saas-platforms" }],
  });
  store.upsertArtifact({
    relative_path: "operations/it/tooling.toml",
    mtime_ms: 1,
    size_bytes: 1,
    content_hash: "h",
    owner: "team/humans/maria",
    artifact_kind: "other",
    tags: ["operational"],
  });
  store.upsertArtifact({
    relative_path: "governance/parties/acme.toml",
    mtime_ms: 1,
    size_bytes: 1,
    content_hash: "h",
    owner: "team/humans/justin",
    artifact_kind: "party",
    tags: ["customer", "investor"],
  });
});

afterEach(() => {
  store.close();
  rmSync(testRoot, { recursive: true, force: true });
});

// ── ownerIndex ──────────────────────────────────────────────

describe("ownerIndex", () => {
  test("groups artifacts by their owner with kind breakdown", () => {
    const summary = ownerIndex(store, "team/humans/justin");
    expect(summary.total).toBe(4);
    expect(summary.by_kind.human).toBe(1);
    expect(summary.by_kind.product).toBe(2);
    expect(summary.by_kind.party).toBe(1);
  });

  test("returns empty result for unknown owner", () => {
    const summary = ownerIndex(store, "team/humans/ghost");
    expect(summary.total).toBe(0);
    expect(summary.artifacts).toEqual([]);
    expect(summary.by_kind).toEqual({});
  });
});

// ── referenceGraph ──────────────────────────────────────────

describe("referenceGraph", () => {
  test("finds inbound references", () => {
    const graph = referenceGraph(store, "customers/segments/saas-platforms");
    expect(graph.inbound_count).toBe(2);
    expect(graph.inbound.map((r) => r.relative_path).sort()).toEqual([
      "products/eventflow/product.toml",
      "products/peer10/product.toml",
    ]);
  });

  test("returns empty when nothing references the target", () => {
    const graph = referenceGraph(store, "nowhere/in/sight");
    expect(graph.inbound_count).toBe(0);
    expect(graph.inbound).toEqual([]);
  });
});

// ── tagCloud ────────────────────────────────────────────────

describe("tagCloud", () => {
  test("returns tags ranked by frequency, then alphabetically", () => {
    const cloud = tagCloud(store);
    // active: 2, saas: 2, customer: 1, founder: 1, investor: 1, operational: 1
    expect(
      cloud
        .slice(0, 2)
        .map((t) => t.tag)
        .sort(),
    ).toEqual(["active", "saas"]);
    expect(cloud.find((t) => t.tag === "active")?.count).toBe(2);
    expect(cloud.find((t) => t.tag === "saas")?.count).toBe(2);
  });

  test("includes every tag", () => {
    const cloud = tagCloud(store);
    const tags = new Set(cloud.map((t) => t.tag));
    expect(tags).toEqual(
      new Set([
        "active",
        "saas",
        "customer",
        "founder",
        "investor",
        "operational",
      ]),
    );
  });
});

// ── staleArtifacts ──────────────────────────────────────────

describe("staleArtifacts", () => {
  test("returns artifacts with reviewed_at older than cutoff", () => {
    // Update one artifact to have an explicit old reviewed_at
    store.upsertArtifact({
      relative_path: "team/humans/justin.toml",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      owner: "team/humans/justin",
      artifact_kind: "human",
      tags: ["founder", "active"],
      references: [],
      reviewed_at: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60d ago
    });
    const summary = staleArtifacts(store, 30); // 30d window
    expect(summary.count).toBeGreaterThan(0);
    expect(
      summary.artifacts.some(
        (a) => a.relative_path === "team/humans/justin.toml",
      ),
    ).toBe(true);
  });
});

// ── listParties ─────────────────────────────────────────────

describe("listParties", () => {
  test("returns only artifact_kind=party rows", () => {
    const parties = listParties(store);
    expect(parties).toHaveLength(1);
    expect(parties[0]?.relative_path).toBe("governance/parties/acme.toml");
  });
});

// ── dashboardSummary ────────────────────────────────────────

describe("dashboardSummary", () => {
  test("aggregates totals and top-N", () => {
    const summary = dashboardSummary(store);
    expect(summary.total_artifacts).toBe(5);
    expect(summary.total_by_kind.human).toBe(1);
    expect(summary.total_by_kind.product).toBe(2);
    expect(summary.total_owners).toBe(2);

    // justin owns 4 artifacts; maria owns 1
    expect(summary.top_owners[0]?.owner).toBe("team/humans/justin");
    expect(summary.top_owners[0]?.count).toBe(4);

    // tags ordered by frequency
    expect(summary.top_tags[0]?.count).toBeGreaterThanOrEqual(
      summary.top_tags[summary.top_tags.length - 1]?.count ?? 0,
    );

    // unresolved_drift_count starts at 0 (no drifts recorded)
    expect(summary.unresolved_drift_count).toBe(0);
  });

  test("reflects drift state from the index", () => {
    store.recordDrift({
      id: "d1",
      relative_path: "x.toml",
      field_path: "f",
      field_class: "intent",
      intent_value: null,
      observed_value: null,
      detector_name: "test",
    });
    const summary = dashboardSummary(store);
    expect(summary.unresolved_drift_count).toBe(1);
  });
});
