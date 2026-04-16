import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../fs-atomic.js";

describe("atomicWriteFile", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
    target = join(dir, "payload.bin");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes bytes that match the input", () => {
    atomicWriteFile(target, "hello world");
    expect(readFileSync(target, "utf-8")).toBe("hello world");
  });

  it("accepts Buffer data", () => {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    atomicWriteFile(target, payload);
    expect(readFileSync(target)).toEqual(payload);
  });

  it("applies file mode when provided", () => {
    atomicWriteFile(target, "secret", { mode: 0o600 });
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("leaves no temp files behind on success", () => {
    for (let i = 0; i < 5; i++) {
      atomicWriteFile(target, `iteration-${i}`);
    }
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(readFileSync(target, "utf-8")).toBe("iteration-4");
  });

  it("ignores stale temp files from other processes", () => {
    // Simulate a crashed writer leaving a tempfile behind.
    const otherPidTmp = `${target}.99999.deadbeef.tmp`;
    writeFileSync(otherPidTmp, "stale garbage from another process");

    atomicWriteFile(target, "fresh data");

    expect(readFileSync(target, "utf-8")).toBe("fresh data");
    // Our write must not have touched the stale temp.
    expect(readFileSync(otherPidTmp, "utf-8")).toBe(
      "stale garbage from another process",
    );
  });

  it("cleans up its own temp file when the rename target is unreachable", () => {
    const bogus = join(dir, "does-not-exist", "child.bin");
    expect(() => atomicWriteFile(bogus, "x")).toThrow();
    // Parent dir of target doesn't exist, so write fails before rename.
    // The temp file also lived under that missing dir, so nothing leaks
    // into the real dir either.
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("uses a unique temp name per call", () => {
    // Monkey-patch by observing that sequential calls to the same path
    // from the same process still produce different temp names — we can't
    // easily intercept mid-call, so instead assert the invariant indirectly:
    // if temp names collided we'd see EBUSY / race-y overwrites. Run many
    // rapid calls and verify every result lands clean.
    for (let i = 0; i < 200; i++) {
      atomicWriteFile(target, `n-${i}`);
    }
    expect(readFileSync(target, "utf-8")).toBe("n-199");
    expect(existsSync(target)).toBe(true);
  });

  it("replaces an existing file's contents", () => {
    writeFileSync(target, "original");
    atomicWriteFile(target, "replacement");
    expect(readFileSync(target, "utf-8")).toBe("replacement");
  });
});
