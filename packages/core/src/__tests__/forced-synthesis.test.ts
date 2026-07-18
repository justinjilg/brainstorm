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
  };
  return {
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
          disableTools: true,
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

  it("runs one tools-disabled synthesis turn and marks recovery=forced_synthesis", async () => {
    // Call 1: 2 steps, finishReason 'tool-calls' at the cap, NO text → capped-empty.
    // Call 2 (synthesis): returns final text.
    _scripts = [
      { parts: [], text: "", finishReason: "tool-calls", steps: 2 },
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
      expect(done.outcome.recovery).toBe("forced_synthesis");
      expect(done.outcome.initialStopCause).toBe("step_cap_reached");
      expect(done.outcome.status).toBe("succeeded");
      expect(done.outcome.hasFinalResponse).toBe(true);
      // Exactly two model calls: the capped attempt + one synthesis turn.
      expect(_streamTextCalls).toHaveLength(2);
      // The synthesis call had NO tools.
      expect(_streamTextCalls[1].tools).toBeUndefined();
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
