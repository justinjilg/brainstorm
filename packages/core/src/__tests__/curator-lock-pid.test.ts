/**
 * Curator lock PID-ownership check (path-to-90 P9c).
 *
 * Pre-P9c, releaseLock unlinked the lock file unconditionally. The v13
 * Attacker (re-verified in v14 evidence) named the resulting race:
 *
 *   T=0     Process A acquires lock (writes pid=A).
 *   T=1     Process A hangs.
 *   T=300s  Stale window passes; process B acquires lock (writes pid=B).
 *   T=301s  Process A wakes up, calls releaseLock, unlinks B's lock.
 *           B now runs unprotected.
 *
 * The fix verifies that the persisted PID matches process.pid before
 * unlinking. Tests below construct each failure mode by hand-writing
 * the lock file and observing releaseLock behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __releaseLockForTests } from "../memory/curator-runner.js";

const LOCK_FILE = ".curator-lock"; // matches CURATOR_LOCK_FILE in curator-runner.ts

let memoryDir: string;
const lockPath = () => join(memoryDir, LOCK_FILE);

beforeEach(() => {
  memoryDir = mkdtempSync(join(tmpdir(), "curator-lock-pid-test-"));
});

afterEach(() => {
  try {
    rmSync(memoryDir, { recursive: true, force: true });
  } catch {
    // tmpdir cleanup best-effort.
  }
});

describe("curator lock — PID ownership check (P9c)", () => {
  it("unlinks the lock when PID matches the current process", () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      "utf-8",
    );
    expect(existsSync(lockPath())).toBe(true);
    __releaseLockForTests(memoryDir);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("REFUSES to unlink when the lock belongs to a different PID (v13 Attacker race)", () => {
    // Simulate the race: process B currently owns the lock (different PID).
    // Process A (us, the test) calls releaseLock — must NOT unlink.
    const foreignPid = process.pid + 1;
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: foreignPid, acquiredAt: Date.now() }),
      "utf-8",
    );
    expect(existsSync(lockPath())).toBe(true);
    __releaseLockForTests(memoryDir);
    expect(existsSync(lockPath()), "foreign-PID lock must survive").toBe(true);
    // And the file content is unchanged — we didn't touch it.
    const after = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(after.pid).toBe(foreignPid);
  });

  it("REFUSES to unlink when the lock file is corrupt (preserves for stale-window recovery)", () => {
    writeFileSync(lockPath(), "{ not valid json", "utf-8");
    expect(existsSync(lockPath())).toBe(true);
    __releaseLockForTests(memoryDir);
    // Don't unlink corrupt files — the stale-window cleanup on next
    // acquire handles them.
    expect(existsSync(lockPath())).toBe(true);
  });

  it("REFUSES to unlink when pid field is missing or non-numeric", () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({ acquiredAt: Date.now() }), // no pid
      "utf-8",
    );
    __releaseLockForTests(memoryDir);
    expect(existsSync(lockPath()), "missing-pid lock must survive").toBe(true);

    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: "not-a-number", acquiredAt: Date.now() }),
      "utf-8",
    );
    __releaseLockForTests(memoryDir);
    expect(existsSync(lockPath()), "non-numeric-pid lock must survive").toBe(
      true,
    );
  });

  it("is a no-op when the lock file does not exist", () => {
    expect(existsSync(lockPath())).toBe(false);
    // Must not throw.
    expect(() => __releaseLockForTests(memoryDir)).not.toThrow();
    expect(existsSync(lockPath())).toBe(false);
  });
});
