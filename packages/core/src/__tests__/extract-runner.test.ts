import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  runExtractionCycle,
  type ExtractCycleOptions,
} from "../memory/extract-runner.js";
import { MemoryManager } from "../memory/manager.js";

// Mock spawnSubagent to avoid needing real providers.
const spawnSubagentMock = vi.fn();
vi.mock("../agent/subagent.js", () => ({
  spawnSubagent: (...args: any[]) => spawnSubagentMock(...args),
}));

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), `extract-test-`));
}

const baseSubagentOptions = {
  config: {} as any,
  registry: {} as any,
  router: {} as any,
  costTracker: {} as any,
  tools: {} as any,
  projectPath: "/tmp/test",
};

function mockResult(text: string, cost = 0.005) {
  return {
    text,
    toolCalls: [],
    cost,
    modelUsed: "claude-haiku-4-5",
    budgetExceeded: false,
  };
}

function getMemoryDirForProject(projectPath: string): string {
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, 16);
  return join(homedir(), ".brainstorm", "projects", hash, "memory");
}

describe("extract-runner", () => {
  let testDir: string;
  let fakeMemoryManager: any;

  beforeEach(() => {
    testDir = createTestDir();
    spawnSubagentMock.mockReset();
    // A minimal fake MemoryManager for tests that don't need real save semantics.
    fakeMemoryManager = {
      list: vi.fn().mockReturnValue([]),
      save: vi.fn(),
    };
  });

  afterEach(() => {
    const lockPath = join(testDir, ".extract-lock");
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  });

  it("accumulates turns across calls and runs once threshold reached", async () => {
    spawnSubagentMock.mockResolvedValue(mockResult("[]"));

    const optsBase: Omit<ExtractCycleOptions, "sessionTurns"> = {
      memoryDir: testDir,
      memoryManager: fakeMemoryManager,
      transcript: "session transcript",
      subagentOptions: baseSubagentOptions,
    };

    const first = await runExtractionCycle({ ...optsBase, sessionTurns: 2 });
    expect(first.ran).toBe(false);
    expect(spawnSubagentMock).not.toHaveBeenCalled();

    const second = await runExtractionCycle({ ...optsBase, sessionTurns: 3 });
    expect(second.ran).toBe(true);
    expect(spawnSubagentMock).toHaveBeenCalledTimes(1);
  });

  it("returns ran:false when lock is held by another process", async () => {
    writeFileSync(
      join(testDir, ".extract-lock"),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      "utf-8",
    );

    const result = await runExtractionCycle({
      memoryDir: testDir,
      memoryManager: fakeMemoryManager,
      transcript: "session transcript",
      sessionTurns: 10,
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(false);
    expect(result.summary).toContain("lock");
    expect(spawnSubagentMock).not.toHaveBeenCalled();
  });

  it("handles malformed JSON output — ran:true, extracted:0, nothing saved", async () => {
    spawnSubagentMock.mockResolvedValue(
      mockResult("Sure, here are some memories: not actually JSON"),
    );

    const result = await runExtractionCycle({
      memoryDir: testDir,
      memoryManager: fakeMemoryManager,
      transcript: "session transcript",
      sessionTurns: 10,
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(true);
    expect(result.extracted).toBe(0);
    expect(fakeMemoryManager.save).not.toHaveBeenCalled();
  });

  it("parses fenced json output", async () => {
    const items = [
      {
        type: "project",
        name: "fenced-fact",
        description: "A fenced fact",
        content: "Content here",
      },
    ];
    spawnSubagentMock.mockResolvedValue(
      mockResult("```json\n" + JSON.stringify(items) + "\n```"),
    );

    const result = await runExtractionCycle({
      memoryDir: testDir,
      memoryManager: fakeMemoryManager,
      transcript: "session transcript",
      sessionTurns: 10,
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(true);
    expect(result.extracted).toBe(1);
    expect(fakeMemoryManager.save).toHaveBeenCalledTimes(1);
    expect(fakeMemoryManager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "fenced-fact",
        source: "llm_extraction",
        author: "extract-runner",
      }),
    );
  });

  it("saves non-duplicate items and skips a duplicate slug without aborting", async () => {
    fakeMemoryManager.list.mockReturnValue([{ name: "existing-fact" }]);
    fakeMemoryManager.save = vi.fn().mockImplementation(() => ({}));

    const items = [
      {
        type: "project",
        name: "existing-fact",
        description: "duplicate",
        content: "dup content",
      },
      {
        type: "project",
        name: "new-fact",
        description: "new",
        content: "new content",
      },
    ];

    // "existing-fact" is already in the index (from list()), so the runner
    // should skip it via the pre-filter and only attempt to save "new-fact".
    spawnSubagentMock.mockResolvedValue(mockResult(JSON.stringify(items)));

    const result = await runExtractionCycle({
      memoryDir: testDir,
      memoryManager: fakeMemoryManager,
      transcript: "session transcript",
      sessionTurns: 10,
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(true);
    expect(result.extracted).toBe(1);
    expect(fakeMemoryManager.save).toHaveBeenCalledTimes(1);
    expect(fakeMemoryManager.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new-fact" }),
    );
  });

  it("continues past a save() collision thrown mid-loop", async () => {
    fakeMemoryManager.list.mockReturnValue([]);
    fakeMemoryManager.save = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("Memory slug collision");
      })
      .mockImplementationOnce(() => ({}));

    const items = [
      { type: "project", name: "a", description: "a", content: "a" },
      { type: "project", name: "b", description: "b", content: "b" },
    ];
    spawnSubagentMock.mockResolvedValue(mockResult(JSON.stringify(items)));

    const result = await runExtractionCycle({
      memoryDir: testDir,
      memoryManager: fakeMemoryManager,
      transcript: "session transcript",
      sessionTurns: 10,
      subagentOptions: baseSubagentOptions,
    });

    expect(result.ran).toBe(true);
    expect(result.extracted).toBe(1);
    expect(fakeMemoryManager.save).toHaveBeenCalledTimes(2);
  });

  describe("trust/quarantine with a real MemoryManager", () => {
    let projectPath: string;
    let memoryDir: string;
    let manager: MemoryManager;

    beforeEach(() => {
      projectPath = join(
        tmpdir(),
        `extract-runner-mgr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      manager = new MemoryManager(projectPath);
      memoryDir = getMemoryDirForProject(projectPath);
    });

    afterEach(() => {
      manager.dispose();
      try {
        rmSync(memoryDir, { recursive: true, force: true });
      } catch {}
    });

    it("saves llm_extraction entries with trustScore 0.55 in a non-quarantine tier", async () => {
      const items = [
        {
          type: "project",
          name: "real-manager-fact",
          description: "A durable fact",
          content: "The project uses pnpm workspaces.",
        },
      ];
      spawnSubagentMock.mockResolvedValue(mockResult(JSON.stringify(items)));

      const result = await runExtractionCycle({
        memoryDir,
        memoryManager: manager,
        transcript: "session transcript",
        sessionTurns: 10,
        subagentOptions: baseSubagentOptions,
      });

      expect(result.ran).toBe(true);
      expect(result.extracted).toBe(1);

      const saved = manager.get("real-manager-fact");
      expect(saved).toBeDefined();
      expect(saved?.source).toBe("llm_extraction");
      expect(saved?.trustScore).toBe(0.55);
      expect(saved?.tier).not.toBe("quarantine");
    });
  });
});
