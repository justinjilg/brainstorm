/**
 * Tests for the ratchet state machine + sentinels + coherence detector.
 *
 * Coverage:
 *   - state-machine transitions (legal vs illegal)
 *   - sentinel CRUD (write / load / round-trip)
 *   - startRatchet refuses when an active sentinel exists for the same bundle
 *   - expired sentinels are NOT considered active
 *   - completeRatchet / abandonRatchet / stealRatchet
 *   - stealRatchet's superseded → replacement linkage
 *   - verifyRecipientSetCoherence detects partial-ratchet mismatch
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isValidTransition,
  VALID_TRANSITIONS,
  loadRatchetSentinel,
  writeRatchetSentinel,
  ratchetSentinelPath,
  startRatchet,
  completeRatchet,
  abandonRatchet,
  stealRatchet,
  findActiveRatchet,
  verifyRecipientSetCoherence,
  type RatchetSentinel,
} from "../ratchet.js";

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "ratchet-test-"));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const sample = (overrides: Partial<RatchetSentinel> = {}): RatchetSentinel => ({
  id: "ratchet_test123",
  bundle_id: "bundle_managers",
  state: "started",
  started_by: "team/humans/justin",
  started_at: new Date().toISOString(),
  machine_id: "macbook-pro-2",
  expires_in_minutes: 120,
  ...overrides,
});

// ── state machine ──────────────────────────────────────────

describe("ratchet — state machine", () => {
  test("started → completed | abandoned | stolen are legal", () => {
    expect(isValidTransition("started", "completed")).toBe(true);
    expect(isValidTransition("started", "abandoned")).toBe(true);
    expect(isValidTransition("started", "stolen")).toBe(true);
  });

  test("started → started is illegal", () => {
    expect(isValidTransition("started", "started")).toBe(false);
  });

  test("completed / superseded are terminal", () => {
    expect(VALID_TRANSITIONS.completed).toEqual([]);
    expect(VALID_TRANSITIONS.superseded).toEqual([]);
    expect(isValidTransition("completed", "started")).toBe(false);
    expect(isValidTransition("completed", "abandoned")).toBe(false);
  });

  test("abandoned → superseded is the only non-terminal abandonment path", () => {
    expect(isValidTransition("abandoned", "superseded")).toBe(true);
    expect(isValidTransition("abandoned", "started")).toBe(false);
    expect(isValidTransition("abandoned", "completed")).toBe(false);
  });
});

// ── sentinel CRUD ──────────────────────────────────────────

describe("ratchet — sentinel CRUD", () => {
  test("write + load round-trips a sentinel", () => {
    const path = ratchetSentinelPath(testRoot, "ratchet_abc");
    const original = sample({ id: "ratchet_abc" });
    writeRatchetSentinel(path, original);

    const result = loadRatchetSentinel(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sentinel.id).toBe("ratchet_abc");
      expect(result.sentinel.bundle_id).toBe("bundle_managers");
      expect(result.sentinel.state).toBe("started");
      expect(result.sentinel.expires_in_minutes).toBe(120);
    }
  });

  test("load returns error for missing path", () => {
    const r = loadRatchetSentinel(join(testRoot, "absent.toml"));
    expect(r.ok).toBe(false);
  });

  test("load rejects schema-invalid sentinels", () => {
    const path = ratchetSentinelPath(testRoot, "ratchet_bad");
    // Manual write with bad id format
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(join(testRoot, ".harness/ratchets"), { recursive: true });
    fs.writeFileSync(
      path,
      `id = "wrong-prefix"
bundle_id = "bundle_x"
state = "started"
started_by = "x"
started_at = "2026-04-27T18:00:00Z"
machine_id = "x"
expires_in_minutes = 120
`,
    );
    const r = loadRatchetSentinel(path);
    expect(r.ok).toBe(false);
  });
});

// ── startRatchet ───────────────────────────────────────────

describe("startRatchet", () => {
  test("creates a fresh sentinel with started state", () => {
    const sentinel = startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_managers",
      startedBy: "team/humans/justin",
      machineId: "macbook-pro-2",
    });
    expect(sentinel.state).toBe("started");
    expect(sentinel.id).toMatch(/^ratchet_/);
    // Verify the file landed
    const loaded = loadRatchetSentinel(
      ratchetSentinelPath(testRoot, sentinel.id),
    );
    expect(loaded.ok).toBe(true);
  });

  test("refuses when an active sentinel exists on the same bundle", () => {
    startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_managers",
      startedBy: "team/humans/justin",
      machineId: "macbook-pro-2",
    });
    expect(() =>
      startRatchet({
        harnessRoot: testRoot,
        bundleId: "bundle_managers",
        startedBy: "team/humans/alex",
        machineId: "thinkpad",
      }),
    ).toThrow(/already active/);
  });

  test("allows starting a ratchet on a different bundle concurrently", () => {
    const a = startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_managers",
      startedBy: "team/humans/justin",
      machineId: "m",
    });
    const b = startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_legal",
      startedBy: "team/humans/justin",
      machineId: "m",
    });
    expect(a.id).not.toBe(b.id);
    expect(a.bundle_id).not.toBe(b.bundle_id);
  });
});

// ── findActiveRatchet ──────────────────────────────────────

describe("findActiveRatchet", () => {
  test("returns null when no sentinels exist", () => {
    expect(findActiveRatchet(testRoot, "bundle_x")).toBeNull();
  });

  test("ignores expired sentinels", () => {
    const path = ratchetSentinelPath(testRoot, "ratchet_old");
    writeRatchetSentinel(
      path,
      sample({
        id: "ratchet_old",
        started_at: new Date(Date.now() - 200 * 60_000).toISOString(),
        expires_in_minutes: 60, // expired 140 min ago
      }),
    );
    expect(findActiveRatchet(testRoot, "bundle_managers")).toBeNull();
  });

  test("ignores terminal-state sentinels", () => {
    const path = ratchetSentinelPath(testRoot, "ratchet_done");
    writeRatchetSentinel(
      path,
      sample({ id: "ratchet_done", state: "completed" }),
    );
    expect(findActiveRatchet(testRoot, "bundle_managers")).toBeNull();
  });
});

// ── completeRatchet / abandonRatchet ───────────────────────

describe("completeRatchet / abandonRatchet", () => {
  test("complete transitions started → completed", () => {
    const s = startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_managers",
      startedBy: "team/humans/justin",
      machineId: "m",
    });
    const completed = completeRatchet(testRoot, s.id, 142);
    expect(completed.state).toBe("completed");
    expect(completed.files_touched).toBe(142);
    expect(completed.ended_at).toBeDefined();
  });

  test("complete is idempotent (re-completing returns existing)", () => {
    const s = startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_b",
      startedBy: "x",
      machineId: "m",
    });
    completeRatchet(testRoot, s.id, 50);
    expect(() => completeRatchet(testRoot, s.id, 99)).not.toThrow();
  });

  test("abandon transitions started → abandoned", () => {
    const s = startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_b",
      startedBy: "x",
      machineId: "m",
    });
    const a = abandonRatchet(testRoot, s.id);
    expect(a.state).toBe("abandoned");
  });

  test("complete throws when sentinel is in terminal state", () => {
    const s = startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_b",
      startedBy: "x",
      machineId: "m",
    });
    abandonRatchet(testRoot, s.id);
    expect(() => completeRatchet(testRoot, s.id, 1)).toThrow(
      /cannot transition/,
    );
  });
});

// ── stealRatchet ──────────────────────────────────────────

describe("stealRatchet", () => {
  test("creates a replacement and abandons the victim", () => {
    const victim = startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_managers",
      startedBy: "team/humans/justin",
      machineId: "macbook",
    });

    const result = stealRatchet({
      harnessRoot: testRoot,
      victimRatchetId: victim.id,
      newStartedBy: "team/humans/alex",
      newMachineId: "thinkpad",
      reason: "emergency contractor revocation",
      governanceDecisionRef:
        "governance/decisions/2026-04-27-emergency-revocation.md",
    });

    expect(result.superseded.state).toBe("abandoned");
    expect(result.superseded.superseded_by).toBe(result.replacement.id);
    expect(result.replacement.state).toBe("started");
    expect(result.replacement.stole_from).toBe(victim.id);
    expect(result.replacement.bundle_id).toBe(victim.bundle_id);
  });

  test("refuses to steal a victim that's not in started state", () => {
    const victim = startRatchet({
      harnessRoot: testRoot,
      bundleId: "bundle_b",
      startedBy: "x",
      machineId: "m",
    });
    completeRatchet(testRoot, victim.id, 0);
    expect(() =>
      stealRatchet({
        harnessRoot: testRoot,
        victimRatchetId: victim.id,
        newStartedBy: "y",
        newMachineId: "m2",
        reason: "x",
        governanceDecisionRef: "x",
      }),
    ).toThrow(/not in 'started' state/);
  });
});

// ── recipient-set coherence ────────────────────────────────

describe("verifyRecipientSetCoherence", () => {
  test("all files matching expected set → all coherent, no incoherent", () => {
    const result = verifyRecipientSetCoherence({
      bundleId: "bundle_managers",
      expectedRecipients: ["age1a", "age1b", "age1c"],
      filesAndRecipients: [
        {
          path: "team/perf/jane.md.age",
          recipients: ["age1a", "age1b", "age1c"],
        },
        {
          path: "team/perf/bob.md.age",
          recipients: ["age1c", "age1b", "age1a"],
        }, // order doesn't matter
      ],
    });
    expect(result.coherent).toHaveLength(2);
    expect(result.incoherent).toEqual([]);
  });

  test("file missing one recipient → incoherent with missing_from_file", () => {
    const result = verifyRecipientSetCoherence({
      bundleId: "bundle_managers",
      expectedRecipients: ["age1a", "age1b", "age1c"],
      filesAndRecipients: [
        { path: "x.age", recipients: ["age1a", "age1b"] }, // missing 1c
      ],
    });
    expect(result.coherent).toEqual([]);
    expect(result.incoherent).toHaveLength(1);
    expect(result.incoherent[0]?.missing_from_file).toEqual(["age1c"]);
    expect(result.incoherent[0]?.extra_in_file).toEqual([]);
  });

  test("file with extra recipient → incoherent with extra_in_file", () => {
    const result = verifyRecipientSetCoherence({
      bundleId: "bundle_managers",
      expectedRecipients: ["age1a"],
      filesAndRecipients: [
        { path: "x.age", recipients: ["age1a", "age1stranger"] },
      ],
    });
    expect(result.incoherent[0]?.extra_in_file).toEqual(["age1stranger"]);
  });

  test("the partial-ratchet failure mode is detected", () => {
    // Round 1 Attack #1: ~3,200 files, two pick-one merges leave 78 files
    // encrypted to a recipient set that's missing the controller's edit.
    // Simulate a small version with N=4.
    const result = verifyRecipientSetCoherence({
      bundleId: "bundle_managers",
      expectedRecipients: ["age1a", "age1b", "age1NEW_CONTRACTOR"],
      filesAndRecipients: [
        {
          path: "ok1.age",
          recipients: ["age1a", "age1b", "age1NEW_CONTRACTOR"],
        },
        {
          path: "ok2.age",
          recipients: ["age1a", "age1b", "age1NEW_CONTRACTOR"],
        },
        // These two files lost the new-contractor recipient because the
        // ratchet merge picked the wrong winner
        { path: "broken1.age", recipients: ["age1a", "age1b"] },
        { path: "broken2.age", recipients: ["age1a", "age1b"] },
      ],
    });
    expect(result.coherent).toHaveLength(2);
    expect(result.incoherent).toHaveLength(2);
    expect(
      result.incoherent.every(
        (i) => i.missing_from_file[0] === "age1NEW_CONTRACTOR",
      ),
    ).toBe(true);
  });
});
