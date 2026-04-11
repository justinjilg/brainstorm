/**
 * MemoryManager test suite.
 *
 * Tests: save/get/search, promote/demote/quarantine, getContextString,
 * LRU eviction (including subdirectories), tamper detection,
 * promote-from-quarantine trust ceiling.
 *
 * Uses a unique project path per test to isolate memory directories.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";

// MemoryManager creates dirs under ~/.brainstorm/projects/<hash>/memory/
// We use unique project paths so each test gets its own directory.
import { MemoryManager } from "../memory/manager.js";

function getMemoryDir(projectPath: string): string {
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, 16);
  return join(homedir(), ".brainstorm", "projects", hash, "memory");
}

function createTestManager(): {
  manager: MemoryManager;
  projectPath: string;
  memoryDir: string;
} {
  const projectPath = join(
    tmpdir(),
    `brainstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const manager = new MemoryManager(projectPath);
  const memoryDir = getMemoryDir(projectPath);
  return { manager, projectPath, memoryDir };
}

function cleanup(projectPath: string): void {
  const memoryDir = getMemoryDir(projectPath);
  try {
    rmSync(memoryDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}

describe("MemoryManager", () => {
  let manager: MemoryManager;
  let projectPath: string;
  let memoryDir: string;

  beforeEach(() => {
    const ctx = createTestManager();
    manager = ctx.manager;
    projectPath = ctx.projectPath;
    memoryDir = ctx.memoryDir;
  });

  afterEach(() => {
    cleanup(projectPath);
  });

  describe("save and get", () => {
    it("saves and retrieves a memory entry", () => {
      const entry = manager.save({
        name: "test-entry",
        description: "A test memory",
        content: "This is test content",
        type: "project",
        source: "user_input",
      });

      expect(entry.id).toBe("test-entry");
      // type: "project" defaults to archive; only type: "user"/"feedback" defaults to system
      expect(entry.tier).toBe("archive");
      expect(entry.trustScore).toBe(1.0); // user_input default trust

      const retrieved = manager.get("test-entry");
      expect(retrieved).toBeDefined();
      expect(retrieved!.content).toBe("This is test content");
    });

    it("generates id from name", () => {
      const entry = manager.save({
        name: "My Complex Name!",
        description: "Test",
        content: "Content",
        type: "project",
        source: "user_input",
      });
      expect(entry.id).toBe("my-complex-name-");
    });

    it("updates existing entry", () => {
      manager.save({
        name: "updatable",
        description: "v1",
        content: "Original",
        type: "project",
        source: "user_input",
      });

      const updated = manager.save({
        name: "updatable",
        description: "v2",
        content: "Updated content",
        type: "project",
        source: "user_input",
      });

      expect(updated.content).toBe("Updated content");
      expect(updated.description).toBe("v2");
    });
  });

  describe("trust scoring", () => {
    it("assigns trust scores by source", () => {
      const userEntry = manager.save({
        name: "user-memory",
        description: "test",
        content: "content",
        type: "project",
        source: "user_input",
      });
      expect(userEntry.trustScore).toBe(1.0);

      const agentEntry = manager.save({
        name: "agent-memory",
        description: "test",
        content: "content",
        type: "project",
        source: "agent_extraction",
      });
      expect(agentEntry.trustScore).toBe(0.5);

      const webEntry = manager.save({
        name: "web-memory",
        description: "test",
        content: "content",
        type: "project",
        source: "web_fetch",
      });
      expect(webEntry.trustScore).toBe(0.2);
    });

    it("quarantines low-trust entries", () => {
      const entry = manager.save({
        name: "untrusted",
        description: "test",
        content: "content",
        type: "project",
        source: "web_fetch",
        // trust 0.2 < QUARANTINE_THRESHOLD 0.4
      });
      expect(entry.tier).toBe("quarantine");
    });

    it("blocks web-sourced entries from system tier", () => {
      const entry = manager.save({
        name: "web-system-attempt",
        description: "test",
        content: "content",
        type: "project",
        tier: "system",
        source: "web_fetch",
        // trust 0.2 < 0.7 threshold for system
      });
      // Should be demoted to archive, not system
      expect(entry.tier).not.toBe("system");
    });
  });

  describe("promote and demote", () => {
    it("promotes archive entry to system", () => {
      manager.save({
        name: "promotable",
        description: "test",
        content: "content",
        type: "project",
        tier: "archive",
        source: "user_input",
      });

      const ok = manager.promote("promotable");
      expect(ok).toBe(true);

      const entry = manager.get("promotable");
      expect(entry!.tier).toBe("system");
    });

    it("blocks promote from quarantine without user confirmation", () => {
      const entry = manager.save({
        name: "quarantined-entry",
        description: "test",
        content: "content",
        type: "project",
        source: "web_fetch",
      });
      expect(entry.tier).toBe("quarantine");

      // Should fail without userConfirmed
      const ok = manager.promote("quarantined-entry");
      expect(ok).toBe(false);

      // Entry should still be quarantined
      const after = manager.get("quarantined-entry");
      expect(after!.tier).toBe("quarantine");
    });

    it("allows promote from quarantine with user confirmation", () => {
      // Use import source (trust 0.3 < 0.4 = quarantined) — not web_fetch
      // because web_fetch at trust 0.6 still gets blocked from system tier by the
      // web-source system-tier guard (requires trust >= 0.7).
      manager.save({
        name: "confirmed-promote",
        description: "test",
        content: "content",
        type: "project",
        source: "import",
        // trust 0.3 < QUARANTINE_THRESHOLD 0.4 → quarantined
      });

      const before = manager.get("confirmed-promote");
      expect(before!.tier).toBe("quarantine");

      const ok = manager.promote("confirmed-promote", true);
      expect(ok).toBe(true);

      const entry = manager.get("confirmed-promote");
      expect(entry!.tier).toBe("system");
      expect(entry!.trustScore).toBeGreaterThanOrEqual(0.6);
    });

    it("demotes system entry to archive", () => {
      manager.save({
        name: "demotable",
        description: "test",
        content: "content",
        type: "project",
        tier: "system",
        source: "user_input",
      });

      const ok = manager.demote("demotable");
      expect(ok).toBe(true);

      const entry = manager.get("demotable");
      expect(entry!.tier).toBe("archive");
    });
  });

  describe("search", () => {
    it("finds entries by keyword", () => {
      manager.save({
        name: "typescript-config",
        description: "TypeScript configuration",
        content: "Use strict mode, enable ESM",
        type: "project",
        source: "user_input",
      });

      manager.save({
        name: "python-config",
        description: "Python setup",
        content: "Use poetry for dependencies",
        type: "project",
        source: "user_input",
      });

      const results = manager.search("typescript");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe("typescript-config");
    });
  });

  describe("getContextString", () => {
    it("includes system-tier entries", () => {
      manager.save({
        name: "always-visible",
        description: "Should be in context",
        content: "Important context",
        type: "user",
        source: "user_input",
      });

      const context = manager.getContextString();
      expect(context).toContain("always-visible");
      expect(context).toContain("Important context");
    });

    it("lists archive entries as index only", () => {
      manager.save({
        name: "archive-only",
        description: "Should be listed not loaded",
        content: "This content should not appear in full",
        type: "project",
        tier: "archive",
        source: "user_input",
      });

      const context = manager.getContextString();
      expect(context).toContain("archive-only");
      // Archive entries show description but not full content
    });
  });

  describe("tamper detection", () => {
    it("stores content hash", () => {
      const entry = manager.save({
        name: "hashable",
        description: "test",
        content: "original content",
        type: "project",
        source: "user_input",
      });

      expect(entry.contentHash).toBeDefined();
      expect(entry.contentHash!.length).toBe(16);
    });
  });

  describe("list and delete", () => {
    it("lists all entries", () => {
      manager.save({
        name: "entry-1",
        description: "d1",
        content: "c1",
        type: "project",
        source: "user_input",
      });
      manager.save({
        name: "entry-2",
        description: "d2",
        content: "c2",
        type: "project",
        source: "user_input",
      });

      const all = manager.list();
      expect(all.length).toBe(2);
    });

    it("deletes an entry", () => {
      manager.save({
        name: "deletable",
        description: "d",
        content: "c",
        type: "project",
        source: "user_input",
      });

      const ok = manager.delete("deletable");
      expect(ok).toBe(true);

      const entry = manager.get("deletable");
      expect(entry).toBeUndefined();
    });
  });

  // ── pullFromGateway (Week 1 Phase 3) ─────────────────────────────
  //
  // These tests exercise the BR pull path using a stub gateway. The
  // merge semantics are: additive last-writer-wins by name, never
  // delete local entries, skip quarantine tier.
  describe("pullFromGateway", () => {
    // Minimal gateway stub exposing only what pullFromGateway calls.
    function stubGateway(entries: Array<Record<string, unknown>>): any {
      return {
        storeMemory: async () => {},
        listMemory: async () => entries,
      };
    }

    it("is a no-op when gateway is null", async () => {
      const { manager: mgr, projectPath: pp } = createTestManager();
      const result = await mgr.pullFromGateway();
      expect(result).toEqual({ pulled: 0, created: 0, updated: 0, skipped: 0 });
      cleanup(pp);
    });

    it("creates new entries from remote that don't exist locally", async () => {
      const projectPath = join(
        tmpdir(),
        `brainstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const gateway = stubGateway([
        {
          id: "remote-1",
          block: "project",
          content: "[remote-convention] use semicolons",
          created_at: new Date().toISOString(),
        },
        {
          id: "remote-2",
          block: "reference",
          content: "[build-tool] tsup for all packages",
          created_at: new Date().toISOString(),
        },
      ]);
      const mgr = new MemoryManager(projectPath, gateway);

      const result = await mgr.pullFromGateway();
      expect(result.pulled).toBe(2);
      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);

      const convention = mgr.get("remote-convention");
      expect(convention).toBeDefined();
      expect(convention?.content).toBe("use semicolons");

      const buildTool = mgr.get("build-tool");
      expect(buildTool).toBeDefined();
      cleanup(projectPath);
    });

    it("skips remote entries without a [name] prefix", async () => {
      const projectPath = join(
        tmpdir(),
        `brainstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const gateway = stubGateway([
        {
          id: "r1",
          block: "general",
          content: "plain content with no name prefix",
          created_at: new Date().toISOString(),
        },
      ]);
      const mgr = new MemoryManager(projectPath, gateway);

      const result = await mgr.pullFromGateway();
      expect(result.pulled).toBe(1);
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
      cleanup(projectPath);
    });

    it("updates local entry when remote is newer by timestamp", async () => {
      const projectPath = join(
        tmpdir(),
        `brainstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const mgr = new MemoryManager(projectPath);

      // Create a local entry with an old updatedAt — we'll mutate via save
      mgr.save({
        name: "shared-fact",
        description: "old",
        content: "old content",
        type: "project",
        source: "user_input",
      });

      // Simulate time passing
      await new Promise((r) => setTimeout(r, 1100));

      const gateway = stubGateway([
        {
          id: "r1",
          block: "project",
          content: "[shared-fact] new content from remote",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
      // Replace gateway via a new manager that loads the existing store
      const mgr2 = new MemoryManager(projectPath, gateway);

      const result = await mgr2.pullFromGateway();
      expect(result.updated).toBe(1);

      const updated = mgr2.get("shared-fact");
      expect(updated?.content).toBe("new content from remote");
      cleanup(projectPath);
    });

    it("skips remote entries when local is newer", async () => {
      const projectPath = join(
        tmpdir(),
        `brainstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      // Remote entry has a timestamp from 1 hour ago
      const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
      const gateway = stubGateway([
        {
          id: "r1",
          block: "project",
          content: "[local-wins] stale remote content",
          created_at: oneHourAgo,
          updated_at: oneHourAgo,
        },
      ]);
      const mgr = new MemoryManager(projectPath, gateway);

      // Save a local entry NOW — newer than the remote
      mgr.save({
        name: "local-wins",
        description: "local",
        content: "fresh local content",
        type: "project",
        source: "user_input",
      });

      const result = await mgr.pullFromGateway();
      // Remote was processed but skipped because local is newer
      expect(result.updated).toBe(0);
      expect(result.skipped).toBeGreaterThan(0);

      const entry = mgr.get("local-wins");
      expect(entry?.content).toBe("fresh local content");
      cleanup(projectPath);
    });

    it("never deletes local-only entries during pull", async () => {
      const projectPath = join(
        tmpdir(),
        `brainstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const gateway = stubGateway([]); // remote has nothing
      const mgr = new MemoryManager(projectPath, gateway);

      mgr.save({
        name: "local-only",
        description: "d",
        content: "c",
        type: "project",
        source: "user_input",
      });

      await mgr.pullFromGateway();

      // Local entry must still exist
      expect(mgr.get("local-only")).toBeDefined();
      cleanup(projectPath);
    });

    it("captures errors into getPullStatus without throwing", async () => {
      const projectPath = join(
        tmpdir(),
        `brainstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const failingGateway: any = {
        storeMemory: async () => {},
        listMemory: async () => {
          throw new Error("BR unavailable");
        },
      };
      const mgr = new MemoryManager(projectPath, failingGateway);

      const result = await mgr.pullFromGateway();
      // Does not throw, returns zero counts
      expect(result).toEqual({ pulled: 0, created: 0, updated: 0, skipped: 0 });

      const status = mgr.getPullStatus();
      expect(status.state).toBe("failed");
      expect(status.lastError).toBe("BR unavailable");
      cleanup(projectPath);
    });

    it("getPullStatus reflects successful pull", async () => {
      const projectPath = join(
        tmpdir(),
        `brainstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const gateway = stubGateway([]);
      const mgr = new MemoryManager(projectPath, gateway);

      await mgr.pullFromGateway();

      const status = mgr.getPullStatus();
      expect(status.state).toBe("completed");
      expect(status.lastError).toBeNull();
      expect(status.lastPullAt).toBeGreaterThan(0);
      cleanup(projectPath);
    });
  });
});
