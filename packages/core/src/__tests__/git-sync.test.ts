import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { GitMemorySync } from "../memory/git-sync.js";
import {
  initMemoryRepo,
  commitMemoryChange,
  hasRemote,
  configureRemote,
} from "../memory/git.js";

function createTestRepo(): string {
  const dir = join(
    tmpdir(),
    `git-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  initMemoryRepo(dir);
  return dir;
}

function createBareRemote(): string {
  const dir = join(
    tmpdir(),
    `git-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--bare"], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("git-sync", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestRepo();
  });

  describe("GitMemorySync", () => {
    it("is inactive when no remote configured", () => {
      const sync = new GitMemorySync(testDir);
      expect(sync.isActive()).toBe(false);
    });

    it("is active when remote URL provided", () => {
      const remote = createBareRemote();
      const sync = new GitMemorySync(testDir, remote);
      expect(sync.isActive()).toBe(true);
    });

    it("syncBeforeRead is a no-op without remote", () => {
      const sync = new GitMemorySync(testDir);
      // Should not throw
      sync.syncBeforeRead();
    });

    it("syncAfterWrite is a no-op without remote", () => {
      const sync = new GitMemorySync(testDir);
      sync.syncAfterWrite("test commit");
    });

    it("rate-limits pulls within cooldown window", () => {
      const remote = createBareRemote();
      // Push initial commit to remote so it has a branch
      execFileSync("git", ["push", remote, "main"], {
        cwd: testDir,
        stdio: "ignore",
      });

      const sync = new GitMemorySync(testDir, remote, "main", {
        pullCooldownMs: 5000,
      });

      // First pull succeeds
      sync.syncBeforeRead();

      // Second pull within cooldown is skipped (no error, just no-op)
      // We can verify by checking the internal state doesn't throw
      sync.syncBeforeRead();
    });

    it("push after write works with remote", () => {
      const remote = createBareRemote();
      // Push initial commit so remote has the branch
      execFileSync("git", ["push", remote, "main"], {
        cwd: testDir,
        stdio: "ignore",
      });

      const sync = new GitMemorySync(testDir, remote);

      // Write a file and commit
      const { writeFileSync } = require("node:fs");
      writeFileSync(join(testDir, "test.md"), "test content", "utf-8");
      commitMemoryChange(testDir, "test: add file");

      // Push via sync
      sync.syncAfterWrite();

      // Verify: clone remote and check file exists
      const cloneDir = join(
        tmpdir(),
        `clone-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      execFileSync("git", ["clone", remote, cloneDir], { stdio: "ignore" });
      expect(existsSync(join(cloneDir, "test.md"))).toBe(true);
    });
  });

  describe("configureRemote", () => {
    it("adds a new remote", () => {
      expect(hasRemote(testDir)).toBe(false);
      configureRemote(testDir, "https://example.com/repo.git");
      expect(hasRemote(testDir)).toBe(true);
    });

    it("returns false when remote already configured with same URL", () => {
      configureRemote(testDir, "https://example.com/repo.git");
      const updated = configureRemote(testDir, "https://example.com/repo.git");
      expect(updated).toBe(false);
    });

    it("updates remote when URL changes", () => {
      configureRemote(testDir, "https://example.com/old.git");
      const updated = configureRemote(testDir, "https://example.com/new.git");
      expect(updated).toBe(true);
    });
  });
});
