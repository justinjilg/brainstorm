/**
 * Tests for AuditLogWriter — append-only JSONL with hash-chain integrity.
 *
 * Coverage:
 *   - basic append + read round-trip
 *   - chain hash links: each entry's prev_sha256 = sha256(previous serialized line)
 *   - sequence numbers increment monotonically
 *   - verifyChain detects:
 *       a) tampered intermediate entry
 *       b) deleted entry
 *       c) reordered entries
 *   - multi-instance writers continue the chain across process boundaries
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { AuditLogWriter, type AuditEvent, auditLogPath } from "../audit-log.js";

let testRoot: string;
let logPath: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "audit-test-"));
  logPath = join(testRoot, "log.jsonl");
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const decryptEvent = (overrides = {}): AuditEvent => ({
  kind: "decrypt",
  at: "2026-04-27T18:00:00Z",
  actor_type: "human",
  actor_ref: "team/humans/justin",
  reason: "test",
  artifact_path: "team/perf/jane.md.age",
  bundle_id: "bundle_managers",
  plaintext_sha256: "a".repeat(64),
  ...overrides,
});

// ── basic append + read ─────────────────────────────────────

describe("AuditLogWriter — append + read", () => {
  test("appends a single event and reads it back", () => {
    const w = new AuditLogWriter(logPath);
    w.append(decryptEvent());
    const entries = w.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("decrypt");
    expect(entries[0]?.seq).toBe(1);
    expect(entries[0]?.prev_sha256).toBeNull();
  });

  test("appends multiple events; sequence increments monotonically", () => {
    const w = new AuditLogWriter(logPath);
    w.append(decryptEvent());
    w.append(decryptEvent({ artifact_path: "x" }));
    w.append(decryptEvent({ artifact_path: "y" }));
    const entries = w.read();
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("supports diverse event kinds", () => {
    const w = new AuditLogWriter(logPath);
    w.append({
      kind: "capability-grant",
      at: "2026-04-27T18:00:00Z",
      actor_type: "human",
      actor_ref: "team/humans/justin",
      reason: "Q2 reviews",
      agent_ref: "team/agents/kairos",
      bundle_id: "bundle_managers",
      expires_at: "2026-07-27",
    });
    w.append({
      kind: "ratchet-complete",
      at: "2026-04-27T18:01:00Z",
      actor_type: "human",
      actor_ref: "team/humans/justin",
      reason: "remove ex-employee",
      ratchet_id: "ratchet_x",
      bundle_id: "bundle_managers",
      files_touched: 142,
    });
    const entries = w.read();
    expect(entries[0]?.kind).toBe("capability-grant");
    expect(entries[1]?.kind).toBe("ratchet-complete");
  });
});

// ── chain integrity ─────────────────────────────────────────

describe("AuditLogWriter — hash chain", () => {
  test("each entry's prev_sha256 equals sha256(prior serialized line)", () => {
    const w = new AuditLogWriter(logPath);
    w.append(decryptEvent({ artifact_path: "a" }));
    w.append(decryptEvent({ artifact_path: "b" }));
    w.append(decryptEvent({ artifact_path: "c" }));

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);

    for (let i = 1; i < lines.length; i++) {
      const expectedPrev = createHash("sha256")
        .update(lines[i - 1]!)
        .digest("hex");
      const parsed = JSON.parse(lines[i]!) as { prev_sha256: string };
      expect(parsed.prev_sha256).toBe(expectedPrev);
    }
  });

  test("verifyChain returns ok:true for a clean log", () => {
    const w = new AuditLogWriter(logPath);
    w.append(decryptEvent({ artifact_path: "a" }));
    w.append(decryptEvent({ artifact_path: "b" }));
    w.append(decryptEvent({ artifact_path: "c" }));
    expect(w.verifyChain()).toEqual({ ok: true });
  });

  test("verifyChain returns ok:true for empty / missing log", () => {
    const w = new AuditLogWriter(logPath);
    expect(w.verifyChain()).toEqual({ ok: true });
  });

  test("verifyChain detects a tampered intermediate entry", () => {
    const w = new AuditLogWriter(logPath);
    w.append(decryptEvent({ artifact_path: "a" }));
    w.append(decryptEvent({ artifact_path: "b" }));
    w.append(decryptEvent({ artifact_path: "c" }));

    // Tamper with the middle line — change content but keep prev_sha256
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const tamperedMiddle = lines[1]!.replace('"b"', '"FORGED"');
    lines[1] = tamperedMiddle;
    writeFileSync(logPath, lines.join("\n") + "\n");

    const w2 = new AuditLogWriter(logPath);
    const result = w2.verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The tamper is at index 1 but the *detection* fires at the next
      // entry (index 2) whose prev_sha256 no longer matches the tampered
      // line's hash.
      expect(result.firstBadIndex).toBe(2);
      expect(result.reason).toContain("prev_sha256 mismatch");
    }
  });

  test("verifyChain detects a deleted entry", () => {
    const w = new AuditLogWriter(logPath);
    w.append(decryptEvent({ artifact_path: "a" }));
    w.append(decryptEvent({ artifact_path: "b" }));
    w.append(decryptEvent({ artifact_path: "c" }));

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    // Delete entry 1 (the middle)
    writeFileSync(logPath, [lines[0], lines[2]].join("\n") + "\n");

    const w2 = new AuditLogWriter(logPath);
    const result = w2.verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.firstBadIndex).toBe(1);
  });

  test("verifyChain detects reordering", () => {
    const w = new AuditLogWriter(logPath);
    w.append(decryptEvent({ artifact_path: "a" }));
    w.append(decryptEvent({ artifact_path: "b" }));
    w.append(decryptEvent({ artifact_path: "c" }));

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    // Swap entries 1 and 2
    writeFileSync(logPath, [lines[0], lines[2], lines[1]].join("\n") + "\n");

    const w2 = new AuditLogWriter(logPath);
    const result = w2.verifyChain();
    expect(result.ok).toBe(false);
  });
});

// ── continuation across writer instances ────────────────────

describe("AuditLogWriter — continuation", () => {
  test("a fresh writer instance picks up the chain hash + seq from existing log", () => {
    const w1 = new AuditLogWriter(logPath);
    w1.append(decryptEvent({ artifact_path: "a" }));
    w1.append(decryptEvent({ artifact_path: "b" }));

    // Simulate a process restart
    const w2 = new AuditLogWriter(logPath);
    w2.append(decryptEvent({ artifact_path: "c" }));

    const all = w2.read();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(w2.verifyChain()).toEqual({ ok: true });
  });
});

// ── auditLogPath helper ─────────────────────────────────────

describe("auditLogPath", () => {
  test("composes the standard path inside a harness root", () => {
    expect(auditLogPath("/home/u/Businesses/x")).toBe(
      "/home/u/Businesses/x/.harness/audit/decrypt-log.md",
    );
  });
});
