/**
 * Tests for StaleArtifactDetector — verifies SLA bands by kind, never-
 * reviewed vs review-overdue distinction, severity escalation by age,
 * and idempotent ids.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessIndexStore } from "@brainst0rm/harness-index";
import { StaleArtifactDetector } from "../stale-artifact-detector.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = 1_800_000_000_000; // fixed test clock

let testRoot: string;
let store: HarnessIndexStore;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "stale-test-"));
  store = new HarnessIndexStore(join(testRoot, "x.db"));
});

afterEach(() => {
  store.close();
  rmSync(testRoot, { recursive: true, force: true });
});

const detector = (overrides = {}) =>
  new StaleArtifactDetector(store, { now: () => NOW_MS, ...overrides });

describe("StaleArtifactDetector — review-overdue", () => {
  test("emits drift when reviewed_at is older than kind's SLA", () => {
    // contract SLA = 90d; reviewed 100d ago → stale
    store.upsertArtifact({
      relative_path: "governance/contracts/customer/acme/2026-msa.md.age",
      mtime_ms: NOW_MS - 100 * DAY_MS,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "contract",
      reviewed_at: NOW_MS - 100 * DAY_MS,
    });

    const drifts = detector().detect();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.field_class).toBe("observation");
    expect(drifts[0]?.field_path).toBe("reviewed_at");
    expect(drifts[0]?.observed_value).toMatch(/since last review/);
  });

  test("does not emit drift when reviewed_at is within SLA", () => {
    // contract SLA = 90d; reviewed 30d ago → fresh
    store.upsertArtifact({
      relative_path: "governance/contracts/customer/x/contract.md",
      mtime_ms: NOW_MS - 30 * DAY_MS,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "contract",
      reviewed_at: NOW_MS - 30 * DAY_MS,
    });
    expect(detector().detect()).toEqual([]);
  });

  test("default kind 'other' uses 365d SLA", () => {
    store.upsertArtifact({
      relative_path: "random/note.md",
      mtime_ms: NOW_MS - 200 * DAY_MS,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "other",
      reviewed_at: NOW_MS - 200 * DAY_MS,
    });
    // 200d < 365d — fresh
    expect(detector().detect()).toEqual([]);

    store.upsertArtifact({
      relative_path: "random/old.md",
      mtime_ms: NOW_MS - 400 * DAY_MS,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "other",
      reviewed_at: NOW_MS - 400 * DAY_MS,
    });
    // 400d > 365d — stale
    expect(detector().detect()).toHaveLength(1);
  });
});

describe("StaleArtifactDetector — never-reviewed fallback", () => {
  test("uses indexed_at as fallback when reviewed_at is null", () => {
    // okr SLA = 30d; indexed 60d ago, never reviewed → stale
    store.upsertArtifact({
      relative_path: "team/performance/okrs/2026-Q1/justin.toml",
      mtime_ms: NOW_MS - 60 * DAY_MS,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "okr",
      reviewed_at: null,
    });

    // Manually set indexed_at by directly running upsert above; but
    // upsertArtifact stamps `now` for indexed_at. We re-run a prepared
    // statement to backdate it for the test.
    const db = (
      store as unknown as {
        db: { prepare(s: string): { run: (...a: unknown[]) => void } };
      }
    ).db;
    db.prepare(
      "UPDATE indexed_artifacts SET indexed_at = ? WHERE relative_path = ?",
    ).run(NOW_MS - 60 * DAY_MS, "team/performance/okrs/2026-Q1/justin.toml");

    const drifts = detector().detect();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.observed_value).toMatch(
      /never-reviewed|since first index/,
    );
  });

  test("never-reviewed within SLA does NOT emit", () => {
    // human SLA = 180d. Backdate indexed_at to 30d before NOW_MS — fresh.
    store.upsertArtifact({
      relative_path: "team/humans/justin.toml",
      mtime_ms: NOW_MS - 30 * DAY_MS,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "human",
      reviewed_at: null,
    });
    const db = (
      store as unknown as {
        db: { prepare(s: string): { run: (...a: unknown[]) => void } };
      }
    ).db;
    db.prepare(
      "UPDATE indexed_artifacts SET indexed_at = ? WHERE relative_path = ?",
    ).run(NOW_MS - 30 * DAY_MS, "team/humans/justin.toml");

    expect(detector().detect()).toEqual([]);
  });
});

describe("StaleArtifactDetector — severity bands", () => {
  test("contract 130d (overdue 40d) gets high severity", () => {
    // contract SLA = 90d, overdueDays = 40 → sensitivity 2 + ≥30 overdue → high
    store.upsertArtifact({
      relative_path: "governance/contracts/x.md",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "contract",
      reviewed_at: NOW_MS - 130 * DAY_MS,
    });
    expect(detector().detect()[0]?.severity).toBe("high");
  });

  test("contract 100d (overdue 10d) gets medium severity", () => {
    // contract SLA = 90d, overdueDays = 10 → sensitivity 2 + ≥1 overdue → medium
    store.upsertArtifact({
      relative_path: "governance/contracts/x.md",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "contract",
      reviewed_at: NOW_MS - 100 * DAY_MS,
    });
    expect(detector().detect()[0]?.severity).toBe("medium");
  });

  test("policy 200d (overdue 20d) gets low severity (low sensitivity, mild overdue)", () => {
    // policy SLA = 180d, overdueDays = 20 → sensitivity 0 + < 90 overdue → low
    store.upsertArtifact({
      relative_path: "team/policies/code-of-conduct.md",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "policy",
      reviewed_at: NOW_MS - 200 * DAY_MS,
    });
    expect(detector().detect()[0]?.severity).toBe("low");
  });

  test("policy 280d (overdue 100d) gets medium severity (low sensitivity, deep overdue)", () => {
    // policy SLA = 180d, overdueDays = 100 → sensitivity 0 + ≥ 90 overdue → medium
    store.upsertArtifact({
      relative_path: "team/policies/code-of-conduct.md",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "policy",
      reviewed_at: NOW_MS - 280 * DAY_MS,
    });
    expect(detector().detect()[0]?.severity).toBe("medium");
  });
});

describe("StaleArtifactDetector — overrides", () => {
  test("custom slasDays overrides default", () => {
    store.upsertArtifact({
      relative_path: "x.md",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "decision",
      reviewed_at: NOW_MS - 10 * DAY_MS,
    });
    // Default decision SLA = 365d; with override of 5d, this is stale
    const d = detector({ slasDays: { decision: 5 } });
    expect(d.detect()).toHaveLength(1);
  });

  test("custom severityFor returns the requested severity", () => {
    store.upsertArtifact({
      relative_path: "x.md",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "contract",
      reviewed_at: NOW_MS - 100 * DAY_MS,
    });
    const d = detector({ severityFor: () => "incident-required" as const });
    expect(d.detect()[0]?.severity).toBe("incident-required");
  });
});

describe("StaleArtifactDetector — idempotent ids", () => {
  test("same drift across calls returns same id", () => {
    store.upsertArtifact({
      relative_path: "governance/contracts/x.md",
      mtime_ms: 1,
      size_bytes: 1,
      content_hash: "h",
      artifact_kind: "contract",
      reviewed_at: NOW_MS - 100 * DAY_MS,
    });
    const d = detector();
    const id1 = d.detect()[0]?.id;
    const id2 = d.detect()[0]?.id;
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });
});
