import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Capture every streamText invocation's options so we can assert the loop
// forwards the routed model's output-token budget.
let _streamTextCalls: any[] = [];

vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamText: vi.fn((opts: any) => {
      _streamTextCalls.push(opts);
      if (opts.onStepFinish) {
        setImmediate(() => {
          opts.onStepFinish({
            usage: { inputTokens: 5, outputTokens: 2 },
            finishReason: "stop",
          });
        });
      }
      async function* fullStream() {
        yield { type: "text-delta", text: "ok" };
      }
      return {
        fullStream: fullStream(),
        textStream: (async function* () {})(),
        text: Promise.resolve("ok"),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
        finishReason: Promise.resolve("stop"),
        response: Promise.resolve({ headers: new Map() }),
      };
    }),
  };
});

import { runAgentLoop, computeOutputBudget } from "../agent/loop.js";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { getTestDb } from "@brainst0rm/db";
import type { ModelEntry } from "@brainst0rm/shared";

function buildModel(maxOutputTokens: number | undefined): ModelEntry {
  return {
    id: "acronis:test/model",
    provider: "acronis",
    name: "test/model",
    capabilities: {
      toolCalling: true,
      streaming: true,
      vision: false,
      reasoning: true,
      contextWindow: 131072,
      qualityTier: 3,
      speedTier: 2,
      bestFor: ["code-generation"],
    },
    pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 },
    limits: { contextWindow: 131072, maxOutputTokens: maxOutputTokens as any },
    status: "available",
    isLocal: true,
    lastHealthCheck: 0,
  };
}

function buildContext(model: ModelEntry) {
  const tmpProjectPath = mkdtempSync(join(tmpdir(), "brainstorm-maxout-"));
  const originalHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), "brainstorm-home-"));
  process.env.HOME = fakeHome;

  const config: any = {
    general: {
      defaultStrategy: "combined",
      confirmTools: false,
      defaultPermissionMode: "auto",
      theme: "dark",
      maxSteps: 3,
      outputStyle: "concise",
      costSafetyMargin: 1.3,
      loopDetector: { readThreshold: 10, repeatThreshold: 5 },
      subagentIsolation: "none",
    },
    budget: { hardLimit: false },
    routing: { rules: [], fallbackModels: [] },
    shell: { defaultTimeout: 60000, maxOutputBytes: 50000 },
  };

  const registry: any = {
    models: [model],
    getModel: (id: string) => (id === model.id ? model : undefined),
    getProvider: () => ({}),
  };

  const db = getTestDb();
  const sessionId = `maxout-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO sessions (id, project_path, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
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
      const gen = runAgentLoop([{ role: "user" as const, content: "hi" }], {
        config,
        registry,
        router,
        costTracker,
        tools,
        sessionId,
        projectPath: tmpProjectPath,
        systemPrompt: "You are a test agent.",
        preferredModelId: model.id,
        disableTools: true,
        trajectoryEnabled: false,
      } as any);
      const events: any[] = [];
      for await (const ev of gen) {
        events.push(ev);
        if (events.length > 50) break;
      }
      return events;
    },
  };
}

describe("computeOutputBudget", () => {
  const model = (contextWindow?: number, maxOutputTokens?: number) => ({
    limits: { contextWindow, maxOutputTokens },
  });

  it("returns the advertised budget when the prompt is small", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(computeOutputBudget(model(131072, 32768), msgs)).toEqual({
      maxOutputTokens: 32768,
    });
  });

  it("clamps the budget to remaining context near the window limit", () => {
    // ~100k-token prompt in a 128k window: 32k output would overflow.
    const msgs = [{ role: "user", content: "A".repeat(400_000) }];
    const { maxOutputTokens } = computeOutputBudget(
      model(131072, 32768),
      msgs,
    ) as { maxOutputTokens: number };
    expect(maxOutputTokens).toBeLessThan(32768);
    expect(maxOutputTokens).toBeGreaterThanOrEqual(256);
  });

  it("requests exactly the remainder when less than the floor is left", () => {
    // Requesting the 256 floor here would overflow the window — the budget
    // must shrink to what actually remains.
    const window = 131072;
    const msgs = [{ role: "user", content: "hi" }];
    const bigSystem = "S".repeat((window - 1024 - 100) * 4);
    const { maxOutputTokens } = computeOutputBudget(
      model(window, 32768),
      msgs,
      bigSystem,
    ) as { maxOutputTokens: number };
    expect(maxOutputTokens).toBeGreaterThan(0);
    expect(maxOutputTokens).toBeLessThan(256);
  });

  it("keeps a well-formed floor request when the prompt alone exceeds the window", () => {
    const msgs = [{ role: "user", content: "A".repeat(600_000) }];
    expect(computeOutputBudget(model(131072, 32768), msgs)).toEqual({
      maxOutputTokens: 256,
    });
  });

  it("accounts for the measured system prompt, not just messages", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const smallBudget = computeOutputBudget(
      model(131072, 32768),
      msgs,
      "S".repeat(500_000),
    ) as { maxOutputTokens: number };
    expect(smallBudget.maxOutputTokens).toBeLessThan(32768);
  });

  it("omits the option when the model advertises no output limit", () => {
    expect(
      computeOutputBudget(model(131072, undefined), [
        { role: "user", content: "hi" },
      ]),
    ).toEqual({});
  });
});

describe("agent loop — maxOutputTokens forwarding", () => {
  beforeEach(() => {
    _streamTextCalls = [];
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the routed model's maxOutputTokens to streamText", async () => {
    const ctx = buildContext(buildModel(32768));
    try {
      await ctx.run();
      expect(_streamTextCalls.length).toBeGreaterThan(0);
      expect(_streamTextCalls[0].maxOutputTokens).toBe(32768);
    } finally {
      ctx.cleanup();
    }
  });

  it("omits maxOutputTokens when the model advertises no limit", async () => {
    const ctx = buildContext(buildModel(undefined));
    try {
      await ctx.run();
      expect(_streamTextCalls.length).toBeGreaterThan(0);
      expect("maxOutputTokens" in _streamTextCalls[0]).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });
});
