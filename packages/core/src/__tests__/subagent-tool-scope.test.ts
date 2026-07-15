import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the subagent engine but keep the real type registry helpers
// (SUBAGENT_TYPE_NAMES / getSubagentTypeConfig) so clamping math and enum
// construction use real defaults.
vi.mock("../agent/subagent.js", async (importActual) => {
  const actual = await importActual<typeof import("../agent/subagent.js")>();
  return {
    ...actual,
    spawnSubagent: vi.fn().mockResolvedValue({
      text: "ok",
      cost: 0,
      modelUsed: "mock-model",
      toolCalls: [],
      type: "general",
      budgetExceeded: false,
    }),
    spawnParallel: vi.fn().mockResolvedValue([
      {
        text: "ok",
        cost: 0,
        modelUsed: "mock-model",
        toolCalls: [],
        type: "general",
        budgetExceeded: false,
      },
    ]),
  };
});

import { createSubagentTool } from "../agent/subagent-tool.js";
import {
  spawnSubagent,
  spawnParallel,
  getSubagentTypeConfig,
  type SubagentOptions,
} from "../agent/subagent.js";

const spawnSubagentMock = vi.mocked(spawnSubagent);
const spawnParallelMock = vi.mocked(spawnParallel);

// Live tool registry stub — only listTools() is exercised.
const REGISTRY_TOOLS = ["file_read", "grep", "glob", "shell"];

function makeOptions(): SubagentOptions {
  return {
    config: {} as any,
    registry: {} as any,
    router: {} as any,
    costTracker: {
      getSubagentBudget: () => 0.1,
    } as any,
    tools: {
      listTools: () => REGISTRY_TOOLS.map((name) => ({ name })),
    } as any,
    projectPath: "/tmp/project",
  };
}

/** Validate + apply zod defaults, then run the tool's execute. */
async function run(input: unknown) {
  const tool = createSubagentTool(makeOptions());
  const parsed = tool.inputSchema.parse(input);
  return tool.execute(parsed, {});
}

describe("subagent tool — scope narrowing & clamping", () => {
  beforeEach(() => {
    spawnSubagentMock.mockClear();
    spawnParallelMock.mockClear();
  });

  it("clamps model-supplied maxSteps to 2x the type's default", async () => {
    await run({ task: "do it", type: "explore", maxSteps: 999 });
    const [, opts] = spawnSubagentMock.mock.calls[0];
    expect(opts.maxSteps).toBe(
      2 * getSubagentTypeConfig("explore").defaultMaxSteps,
    );
  });

  it("clamps model-supplied budgetLimit to the configured ceiling", async () => {
    await run({ task: "do it", type: "explore", budgetLimit: 5 });
    const [, opts] = spawnSubagentMock.mock.calls[0];
    expect(opts.budgetLimit).toBe(0.1);
  });

  it("leaves maxSteps/budgetLimit undefined when not supplied", async () => {
    await run({ task: "do it", type: "explore" });
    const [, opts] = spawnSubagentMock.mock.calls[0];
    expect(opts.maxSteps).toBeUndefined();
    expect(opts.budgetLimit).toBeUndefined();
  });

  it("passes toolAllowlist and promptAppend through unclamped", async () => {
    await run({
      task: "do it",
      type: "code",
      toolAllowlist: ["file_read", "not_a_real_tool"],
      promptAppend: "extra instructions",
    });
    const [, opts] = spawnSubagentMock.mock.calls[0];
    expect(opts.toolAllowlist).toEqual(["file_read", "not_a_real_tool"]);
    expect(opts.promptAppend).toBe("extra instructions");
  });

  it("populates parentToolNames from the live registry when not preset", async () => {
    await run({ task: "do it", type: "explore" });
    const [, opts] = spawnSubagentMock.mock.calls[0];
    expect(opts.parentToolNames).toEqual(REGISTRY_TOOLS);
  });

  it("forwards per-item fields and clamps in parallel mode", async () => {
    await run({
      parallel: [
        {
          task: "a",
          type: "explore",
          maxSteps: 999,
          budgetLimit: 5,
          toolAllowlist: ["grep"],
          promptAppend: "focus",
        },
        {
          task: "b",
          type: "plan",
        },
      ],
    });
    const [specs, opts] = spawnParallelMock.mock.calls[0];

    // Item 0: explore default is 5 → clamp to 10; budget → 0.1; passthrough.
    expect(specs[0]).toMatchObject({
      task: "a",
      type: "explore",
      maxSteps: 2 * getSubagentTypeConfig("explore").defaultMaxSteps,
      budgetLimit: 0.1,
      toolAllowlist: ["grep"],
      promptAppend: "focus",
    });
    // Item 1: no budgets supplied → undefined.
    expect(specs[1].maxSteps).toBeUndefined();
    expect(specs[1].budgetLimit).toBeUndefined();

    // Parent ceiling still derived from the live registry.
    expect(opts.parentToolNames).toEqual(REGISTRY_TOOLS);
  });

  it("accepts 'research' in the parallel enum (previously omitted)", () => {
    const tool = createSubagentTool(makeOptions());
    const parsed = tool.inputSchema.parse({
      parallel: [{ task: "r", type: "research" }],
    });
    expect(parsed.parallel[0].type).toBe("research");
  });
});
