/**
 * Subagent tool-use enforcement (Phase 7, ported from runAgentLoop).
 *
 * spawnSubagent is a SINGLE streamText call whose model loops internally via
 * stopWhen. When a weak subagent model NARRATES a tool action ("Let me read
 * config.ts") and stops WITHOUT emitting a real call, spawnSubagent must push a
 * corrective user turn and RE-RUN with toolChoice="required" — bounded by
 * config.general.toolEnforcement.maxNudges. These tests drive that bounded
 * re-invocation loop through a stateful streamText mock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each element describes ONE streamText invocation: the parts its fullStream
// yields. The mock pops the next scenario per call so we can script a
// narrate-then-call sequence across re-runs.
let _perCallParts: any[][] = [];
let _callOpts: any[] = [];

vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamText: vi.fn((opts: any) => {
      _callOpts.push(opts);
      const idx = _callOpts.length - 1;
      const parts = _perCallParts[idx] ?? [];
      async function* fullStream() {
        for (const ev of parts) yield ev;
      }
      return {
        fullStream: fullStream(),
        textStream: (async function* () {})(),
        text: Promise.resolve(""),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
        finishReason: Promise.resolve("stop"),
        response: Promise.resolve({ headers: new Map() }),
      };
    }),
  };
});

import { streamText } from "ai";
import { spawnSubagent } from "../agent/subagent.js";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { getTestDb } from "@brainst0rm/db";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { ProviderRegistry } from "@brainst0rm/providers";
import type { ModelEntry } from "@brainst0rm/shared";

function buildCtx(toolEnforcement?: { enabled?: boolean; maxNudges?: number }) {
  const tmpProjectPath = mkdtempSync(join(tmpdir(), "brainstorm-subagent-te-"));
  const originalHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), "brainstorm-home-"));
  process.env.HOME = fakeHome;

  const config: Partial<BrainstormConfig> = {
    general: { maxSteps: 3, toolEnforcement } as any,
    budget: { hardLimit: false } as any,
    routing: { rules: [] } as any,
    shell: { defaultTimeout: 60000, maxOutputBytes: 50000 } as any,
  };

  // Anthropic-style model: canonical tool names pass through the adapter
  // unchanged, so file_read stays file_read (keeps assertions simple).
  const model: ModelEntry = {
    id: "anthropic/claude-opus-4-8",
    provider: "anthropic",
    name: "Claude Opus 4.8",
    capabilities: {
      toolCalling: true,
      streaming: true,
      vision: false,
      reasoning: false,
      contextWindow: 200000,
      qualityTier: 3,
      speedTier: 2,
      bestFor: ["code-generation"],
    },
    pricing: { inputPer1MTokens: 1, outputPer1MTokens: 3 },
    limits: { contextWindow: 200000, maxOutputTokens: 4000 },
    status: "available",
    isLocal: false,
    lastHealthCheck: 0,
  };

  const registry: Partial<ProviderRegistry> = {
    models: [model],
    getModel: (id: string) => (id === model.id ? model : undefined),
    getProvider: () => ({}) as any,
  };

  const db = getTestDb();
  const costTracker = new CostTracker(db, config.budget as any);
  const router = new BrainstormRouter(
    config as any,
    registry as any,
    costTracker,
  );

  const canonicalTools = {
    file_read: { execute: async () => "content", description: "Read a file" },
    glob: { execute: async () => [], description: "Find files" },
    grep: { execute: async () => [], description: "Search content" },
  };
  const tools: any = {
    toAISDKToolsFiltered: (_names: string[]) => ({ ...canonicalTools }),
    toAISDKToolsWithPermissions: (_check: any, _names: string[]) => ({
      ...canonicalTools,
    }),
    toAISDKTools: () => ({ ...canonicalTools }),
  };

  return {
    cleanup: () => {
      rmSync(tmpProjectPath, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome) process.env.HOME = originalHome;
    },
    config,
    registry,
    router,
    costTracker,
    tools,
    tmpProjectPath,
  };
}

const NARRATE = [
  { type: "text-delta", delta: "Let me read config.ts to find the setting." },
  { type: "finish", finishReason: "stop" },
];
const CALLS_TOOL = [
  { type: "tool-call", toolName: "file_read", input: { path: "/config.ts" } },
  { type: "finish", finishReason: "tool-calls" },
];

function spawn(ctx: ReturnType<typeof buildCtx>) {
  return spawnSubagent("read config", {
    config: ctx.config as any,
    registry: ctx.registry as any,
    router: ctx.router,
    costTracker: ctx.costTracker,
    tools: ctx.tools as any,
    projectPath: ctx.tmpProjectPath,
    type: "explore", // read-only; includes file_read, non-empty tool set
    preferredModelId: "anthropic/claude-opus-4-8",
  });
}

describe("subagent — Phase 7 tool-use enforcement", () => {
  let ctx: ReturnType<typeof buildCtx>;
  afterEach(() => ctx?.cleanup());
  beforeEach(() => {
    _perCallParts = [];
    _callOpts = [];
    (streamText as any).mockClear();
  });

  it("nudges a narrated-but-not-called run and forces a tool call on the retry", async () => {
    ctx = buildCtx({ enabled: true, maxNudges: 2 });
    // Run 1 narrates; run 2 (nudged) actually calls the tool.
    _perCallParts = [NARRATE, CALLS_TOOL];

    const result = await spawn(ctx);

    // Exactly one corrective re-run (2 streamText calls total).
    expect((streamText as any).mock.calls.length).toBe(2);
    // The retry forced a real tool call.
    expect(_callOpts[0].toolChoice).toBeUndefined();
    expect(_callOpts[1].toolChoice).toBe("required");
    // The corrective user turn was appended before the retry.
    const retryMsgs = _callOpts[1].messages;
    expect(retryMsgs.length).toBe(3); // user task, assistant narration, user correction
    expect(retryMsgs[1].role).toBe("assistant");
    expect(retryMsgs[2].role).toBe("user");
    expect(retryMsgs[2].content).toContain("[tool-enforcement]");
    // The tool call ended up in the reported toolCalls.
    expect(result.toolCalls).toContain("file_read");
  });

  it("does not nudge a run that calls tools normally", async () => {
    ctx = buildCtx({ enabled: true, maxNudges: 2 });
    _perCallParts = [CALLS_TOOL];

    const result = await spawn(ctx);

    expect((streamText as any).mock.calls.length).toBe(1);
    expect(_callOpts[0].toolChoice).toBeUndefined();
    expect(result.toolCalls).toContain("file_read");
  });

  it("caps re-runs at maxNudges when the model keeps narrating", async () => {
    ctx = buildCtx({ enabled: true, maxNudges: 2 });
    // Model narrates on every run — enforcement must stop after maxNudges.
    _perCallParts = [NARRATE, NARRATE, NARRATE, NARRATE];

    await spawn(ctx);

    // Initial run + 2 nudges = 3 total; never a 4th.
    expect((streamText as any).mock.calls.length).toBe(3);
    // First nudge forces (a further nudge remains); terminal retry does NOT
    // force, so the model can still finish with text.
    expect(_callOpts[0].toolChoice).toBeUndefined();
    expect(_callOpts[1].toolChoice).toBe("required");
    expect(_callOpts[2].toolChoice).toBeUndefined();
  });

  it("is a pure no-op when enforcement is disabled", async () => {
    ctx = buildCtx({ enabled: false, maxNudges: 2 });
    _perCallParts = [NARRATE];

    const result = await spawn(ctx);

    expect((streamText as any).mock.calls.length).toBe(1);
    expect(_callOpts[0].toolChoice).toBeUndefined();
    expect(result.text).toContain("Let me read config.ts");
  });

  it("does not nudge a legitimate plain-text final answer", async () => {
    ctx = buildCtx({ enabled: true, maxNudges: 2 });
    _perCallParts = [
      [
        {
          type: "text-delta",
          delta:
            "The setting lives in config.ts under general.maxSteps. Let me know if you'd like me to change it.",
        },
        { type: "finish", finishReason: "stop" },
      ],
    ];

    const result = await spawn(ctx);

    expect((streamText as any).mock.calls.length).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
  });
});
