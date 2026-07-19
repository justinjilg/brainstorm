import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the streamText mock to simulate a step-capped turn that emits NO final
// text (the coding-model-hit-the-cap scenario), then a synthesis turn that
// does. The mock returns queued scripts in call order.
let _scripts: Array<{
  parts: any[];
  text: string;
  finishReason: string;
  steps: number;
}> = [];
let _callIndex = 0;
const _streamTextCalls: any[] = [];

vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamText: vi.fn((opts: any) => {
      const script = _scripts[_callIndex] ?? {
        parts: [],
        text: "",
        finishReason: "stop",
        steps: 1,
      };
      _callIndex++;
      _streamTextCalls.push(opts);
      if (opts.onStepFinish) {
        // Call synchronously (as real streamText does during stream
        // consumption) so stepsCompleted/lastStepFinishReason are set before
        // the loop's post-stream classifier reads them.
        for (let i = 0; i < script.steps; i++) {
          opts.onStepFinish({
            usage: { inputTokens: 5, outputTokens: 2 },
            finishReason: script.finishReason,
          });
        }
      }
      async function* fullStream() {
        for (const p of script.parts) yield p;
      }
      return {
        fullStream: fullStream(),
        textStream: (async function* () {})(),
        text: Promise.resolve(script.text),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
        finishReason: Promise.resolve(script.finishReason),
        response: Promise.resolve({ headers: new Map() }),
      };
    }),
  };
});

import { runAgentLoop } from "../agent/loop.js";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { getTestDb } from "@brainst0rm/db";
import type { ModelEntry } from "@brainst0rm/shared";

const model: ModelEntry = {
  id: "acronis:mac/qwen/qwen3-coder-next",
  provider: "acronis",
  name: "qwen3-coder-next",
  capabilities: {
    toolCalling: true,
    streaming: true,
    vision: false,
    reasoning: false,
    contextWindow: 262144,
    qualityTier: 3,
    speedTier: 2,
    bestFor: ["code-generation"],
  },
  pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 },
  limits: { contextWindow: 262144, maxOutputTokens: 32768 },
  status: "available",
  isLocal: true,
  lastHealthCheck: 0,
};

function buildContext() {
  const tmpProjectPath = mkdtempSync(join(tmpdir(), "brainstorm-synth-"));
  const originalHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), "brainstorm-home-"));
  process.env.HOME = fakeHome;

  const config: any = {
    general: {
      defaultStrategy: "combined",
      confirmTools: false,
      defaultPermissionMode: "auto",
      theme: "dark",
      maxSteps: 2,
      outputStyle: "concise",
      costSafetyMargin: 1.3,
      loopDetector: { readThreshold: 10, repeatThreshold: 5 },
      subagentIsolation: "none",
    },
    budget: { hardLimit: false },
    routing: { rules: [], fallbackModels: [] }, // no fallback → isolate synthesis
    shell: { defaultTimeout: 60000, maxOutputBytes: 50000 },
  };
  const registry: any = {
    models: [model],
    getModel: (id: string) => (id === model.id ? model : undefined),
    getProvider: () => ({}),
  };
  const db = getTestDb();
  const sessionId = `synth-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO sessions (id, project_path, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(
    sessionId,
    tmpProjectPath,
    Math.floor(Date.now() / 1000),
    Math.floor(Date.now() / 1000),
  );
  const costTracker = new CostTracker(db, config.budget);
  const router = new BrainstormRouter(config, registry, costTracker);
  const tools: any = {
    listTools: () => [],
    list: () => [],
    get: () => undefined,
    filterByNames: () => [],
    toAISDKTools: () => ({}),
    toAISDKToolsFiltered: () => ({}),
    toAISDKToolsWithPermissions: () => ({}),
  };
  return {
    router,
    cleanup: () => {
      rmSync(tmpProjectPath, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome) process.env.HOME = originalHome;
    },
    run: async () => {
      const events: any[] = [];
      for await (const ev of runAgentLoop(
        [{ role: "user" as const, content: "do a thing" }],
        {
          config,
          registry,
          router,
          costTracker,
          tools,
          sessionId,
          projectPath: tmpProjectPath,
          systemPrompt: "test",
          preferredModelId: model.id,
          disableTools: false, // real tool session — synthesis only applies here
          trajectoryEnabled: false,
        } as any,
      )) {
        events.push(ev);
        if (events.length > 60) break;
      }
      return events;
    },
  };
}

describe("forced synthesis on step-cap with no final response", () => {
  beforeEach(() => {
    _scripts = [];
    _callIndex = 0;
    _streamTextCalls.length = 0;
  });
  afterEach(() => vi.clearAllMocks());

    const toolCallScript = (finishReason: string, steps: number) => ({
      parts: [
        { type: "tool-input-start", id: "1", toolName: "file_read" },
        { type: "tool-call", toolName: "file_read", input: { path: "/x" } },
        { type: "tool-result", toolName: "file_read", output: "contents" },
        { type: "finish", finishReason },
      ],
      text: "",
      finishReason,
      steps,
    });

  it("runs one tools-disabled synthesis turn when a capped run wrote no answer", async () => {
    // Call 1: made a tool call, hit the cap (2 steps ≥ maxStepsForRun), no text.
    // Call 2 (synthesis): returns final text.
    _scripts = [
      toolCallScript("tool-calls", 2),
      {
        parts: [{ type: "text-delta", text: "Here is the final answer." }],
        text: "Here is the final answer.",
        finishReason: "stop",
        steps: 1,
      },
    ];
    const ctx = buildContext();
    try {
      const events = await ctx.run();
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      expect(done.outcome).toBeDefined();
      expect(done.outcome.recovery).toEqual(["forced_synthesis"]);
      expect(done.outcome.initialStopCause).toBe("step_cap_reached");
      expect(done.outcome.status).toBe("succeeded");
      expect(done.outcome.hasFinalResponse).toBe(true);
      // Exactly two model calls: the original attempt + one synthesis turn.
      expect(_streamTextCalls).toHaveLength(2);
      // The synthesis call had NO tools.
      expect(_streamTextCalls[1].tools).toBeUndefined();
    } finally {
      ctx.cleanup();
    }
  });

  it("synthesizes when a model stops EARLY after tool calls with no answer (live gpt-oss case)", async () => {
    // The iter-004 live proof: gpt-oss made tool calls then stopped on its own
    // (finishReason 'stop', NOT at the cap) without writing a final answer.
    _scripts = [
      toolCallScript("stop", 1),
      {
        parts: [{ type: "text-delta", text: "Summary of what I found." }],
        text: "Summary of what I found.",
        finishReason: "stop",
        steps: 1,
      },
    ];
    const ctx = buildContext();
    try {
      const events = await ctx.run();
      const done = events.find((e) => e.type === "done");
      expect(done.outcome.recovery).toEqual(["forced_synthesis"]);
      // Preserves that this was a natural early stop, not a cap.
      expect(done.outcome.initialStopCause).toBe("natural_stop");
      expect(done.outcome.hasFinalResponse).toBe(true);
      expect(_streamTextCalls).toHaveLength(2);
    } finally {
      ctx.cleanup();
    }
  });

  it("does not record a silent success when synthesis also produces nothing", async () => {
    // Tool work, no answer → synthesis runs but ALSO returns empty. With no
    // fallbacks configured the run must NOT report hasFinalResponse:true.
    _scripts = [
      toolCallScript("stop", 1),
      { parts: [], text: "", finishReason: "stop", steps: 1 },
    ];
    const ctx = buildContext();
    try {
      const events = await ctx.run();
      const done = events.find((e) => e.type === "done");
      // Synthesis was attempted (2 calls) but produced nothing usable.
      expect(_streamTextCalls).toHaveLength(2);
      expect(done.outcome.hasFinalResponse).toBe(false);
      expect(done.outcome.recovery).toBeUndefined();
      expect(done.outcome.status).toBe("failed");
    } finally {
      ctx.cleanup();
    }
  });

  it("does NOT synthesize on a normal completed turn", async () => {
    _scripts = [
      {
        parts: [{ type: "text-delta", text: "done normally" }],
        text: "done normally",
        finishReason: "stop",
        steps: 1,
      },
    ];
    const ctx = buildContext();
    try {
      const events = await ctx.run();
      const done = events.find((e) => e.type === "done");
      expect(done.outcome.recovery).toBeUndefined();
      expect(done.outcome.initialStopCause).toBe("natural_stop");
      expect(_streamTextCalls).toHaveLength(1);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("momentum recorded only at the terminal (iter-004 deferred #7)", () => {
  beforeEach(() => {
    _scripts = [];
    _callIndex = 0;
    _streamTextCalls.length = 0;
  });
  afterEach(() => vi.clearAllMocks());

  it("records momentum once, with task type, on a normal completed turn", async () => {
    _scripts = [
      {
        parts: [{ type: "text-delta", text: "final answer" }],
        text: "final answer",
        finishReason: "stop",
        steps: 1,
      },
    ];
    const ctx = buildContext();
    const spy = vi.spyOn(ctx.router, "recordSuccess");
    try {
      await ctx.run();
      expect(spy).toHaveBeenCalledTimes(1);
      // task type is passed (was omitted in the original bug).
      expect(spy.mock.calls[0][1]).toBeTypeOf("string");
    } finally {
      ctx.cleanup();
    }
  });

  it("does NOT record momentum when the turn produced no usable result", async () => {
    // Tool work, no answer, synthesis also empty → failed run → no momentum.
    const toolThenEmpty = {
      parts: [
        { type: "tool-input-start", id: "1", toolName: "file_read" },
        { type: "tool-call", toolName: "file_read", input: { path: "/x" } },
        { type: "tool-result", toolName: "file_read", output: "c" },
        { type: "finish", finishReason: "stop" },
      ],
      text: "",
      finishReason: "stop",
      steps: 1,
    };
    _scripts = [
      toolThenEmpty,
      { parts: [], text: "", finishReason: "stop", steps: 1 }, // empty synthesis
    ];
    const ctx = buildContext();
    const spy = vi.spyOn(ctx.router, "recordSuccess");
    try {
      await ctx.run();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      ctx.cleanup();
    }
  });
});
