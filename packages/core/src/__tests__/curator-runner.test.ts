import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runCuratorCycle,
  type CuratorCycleOptions,
} from "../memory/curator-runner.js";

// Mock spawnSubagent to avoid needing real providers
vi.mock("../agent/subagent.js", () => ({
  spawnSubagent: vi.fn().mockResolvedValue({
    text: "Curator completed: merged 1 duplicate, promoted 1 entry",
    toolCalls: [{ name: "file_write", input: {} }],
    cost: 0.005,
    modelUsed: "claude-haiku-4-5",
    budgetExceeded: false,
  }),
}));

function createTestDir(): string {
  const dir = join(
    tmpdir(),
    `curator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMemoryFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, "utf-8");
}

const baseSubagentOptions = {
  config: {} as any,
  registry: {} as any,
  router: {} as any,
  costTracker: {} as any,
  tools: {} as any,
  projectPath: "/tmp/test",
};

describe("curator-runner", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    // Clean up lock files
    const lockPath = join(testDir, ".curator-lock");
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  });

  it("skips when fewer than 3 memory operations", async () => {
    const result = await runCuratorCycle({
      memoryDir: testDir,
      sessionMemoryOps: 2,
      sessionStartMs: Date.now() - 60000,
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(false);
    expect(result.summary).toContain("Only 2 memory ops");
  });

  it("runs when >= 3 memory operations and recent files exist", async () => {
    // Create recent memory files
    const now = Date.now();
    writeMemoryFile(testDir, "test-entry.md", "---\nname: test\n---\nContent");
    writeMemoryFile(
      testDir,
      "another.md",
      "---\nname: another\n---\nMore content",
    );

    const result = await runCuratorCycle({
      memoryDir: testDir,
      sessionMemoryOps: 5,
      sessionStartMs: now - 60000, // 1 minute ago — files are "recent"
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(true);
    expect(result.cost).toBeGreaterThan(0);
    expect(result.filesProcessed).toBe(2);
  });

  it("runs with force even when < 3 memory ops", async () => {
    writeMemoryFile(testDir, "forced.md", "---\nname: forced\n---\nContent");

    const result = await runCuratorCycle({
      memoryDir: testDir,
      sessionMemoryOps: 1,
      sessionStartMs: Date.now() - 60000,
      force: true,
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(true);
  });

  it("skips when no recent files exist", async () => {
    // Create a file but with sessionStartMs in the future
    writeMemoryFile(testDir, "old.md", "---\nname: old\n---\nOld content");

    const result = await runCuratorCycle({
      memoryDir: testDir,
      sessionMemoryOps: 5,
      sessionStartMs: Date.now() + 60000, // future — nothing is "recent"
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(true);
    expect(result.summary).toContain("No recent memory files");
    expect(result.filesProcessed).toBe(0);
  });

  it("fails to acquire lock when another curator is running", async () => {
    // Write a fresh lock
    writeFileSync(
      join(testDir, ".curator-lock"),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      "utf-8",
    );

    const result = await runCuratorCycle({
      memoryDir: testDir,
      sessionMemoryOps: 5,
      sessionStartMs: Date.now() - 60000,
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(false);
    expect(result.summary).toContain("lock");
  });

  it("writes curator state after successful run", async () => {
    writeMemoryFile(testDir, "entry.md", "---\nname: entry\n---\nContent");

    await runCuratorCycle({
      memoryDir: testDir,
      sessionMemoryOps: 3,
      sessionStartMs: Date.now() - 60000,
      subagentOptions: baseSubagentOptions,
    });

    const statePath = join(testDir, ".curator-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.lastCuratorAt).toBeGreaterThan(0);
  });
});
