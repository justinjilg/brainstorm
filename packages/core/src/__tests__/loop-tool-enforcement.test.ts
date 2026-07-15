/**
 * Phase 7 — tool-use enforcement.
 *
 * Weak models sometimes NARRATE a tool action in prose ("Let me read
 * config.ts") and then stop WITHOUT emitting the call. Such a turn is not
 * empty and not a truncated tool-call, so it records as a success and would
 * silently complete. This suite drives scripted fullStreams to prove:
 *
 *   (1) a turn that narrates a tool intent with NO tool call triggers exactly
 *       one corrective re-prompt, and the retry runs with toolChoice="required";
 *   (2) a turn that calls a tool normally is untouched (no nudge);
 *   (3) a legitimate plain-text final answer is NOT nudged;
 *   (4) maxNudges caps the re-prompts (no infinite loop);
 *   (5) enabled:false is a pure no-op (exact legacy behavior);
 *   (6) it composes with verify without compounding into an unbounded loop.
 *
 * Scaffold mirrors loop-verify.test.ts so the diff is mechanical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-CALL scripted stream: the streamText mock pops the next script off the
// queue, so recursive re-runs (nudge / verify) each get their own turn's parts.
let _streamQueue: any[][] = [];
let _finishReason = "stop";

vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamText: vi.fn((opts: any) => {
      const parts =
        _streamQueue.length > 1 ? _streamQueue.shift()! : _streamQueue[0];
      if (opts.onStepFinish) {
        setImmediate(() => {
          opts.onStepFinish({
            usage: { inputTokens: 5, outputTokens: 2 },
            finishReason: _finishReason,
          });
        });
      }
      async function* fullStream() {
        for (const ev of parts) yield ev;
      }
      return {
        fullStream: fullStream(),
        textStream: (async function* () {})(),
        text: Promise.resolve(""),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
        finishReason: Promise.resolve(_finishReason),
        response: Promise.resolve({ headers: new Map() }),
      };
    }),
  };
});

import { streamText } from "ai";
import { runAgentLoop } from "../agent/loop.js";
import type { VerifyOutcome } from "../agent/verify-loop.js";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { getTestDb } from "@brainst0rm/db";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { ProviderRegistry } from "@brainst0rm/providers";
import type { ModelEntry } from "@brainst0rm/shared";

interface RunContext {
  cleanup: () => void;
  config: Partial<BrainstormConfig>;
  registry: Partial<ProviderRegistry>;
  router: BrainstormRouter;
  costTracker: CostTracker;
  tools: any;
  tmpProjectPath: string;
  sessionId: string;
}

function buildContext(): RunContext {
  const tmpProjectPath = mkdtempSync(join(tmpdir(), "brainstorm-te-"));
  const originalHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), "brainstorm-home-"));
  process.env.HOME = fakeHome;

  const config: Partial<BrainstormConfig> = {
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
      // toolEnforcement supplied per-invocation via opts.toolEnforcement.
    } as any,
    budget: { hardLimit: false } as any,
    routing: { rules: [], fallbackModels: [] } as any,
    shell: { defaultTimeout: 60000, maxOutputBytes: 50000 } as any,
  };

  const anthropicModel: ModelEntry = {
    id: "anthropic/claude-sonnet-4.6",
    provider: "anthropic",
    name: "Claude Sonnet 4.6",
    capabilities: {
      toolCalling: true,
      streaming: true,
      vision: false,
      reasoning: false,
      contextWindow: 200000,
      qualityTier: 4,
      speedTier: 3,
      bestFor: ["code-generation"],
    },
    pricing: { inputPer1MTokens: 3, outputPer1MTokens: 15 },
    limits: { contextWindow: 200000, maxOutputTokens: 8000 },
    status: "available",
    isLocal: false,
    lastHealthCheck: 0,
  };

  const registry: Partial<ProviderRegistry> = {
    models: [anthropicModel],
    getModel: (id: string) =>
      id === anthropicModel.id ? anthropicModel : undefined,
    getProvider: () => ({}) as any,
  };

  const db = getTestDb();
  const sessionId = `te-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO sessions (id, project_path, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    sessionId,
    tmpProjectPath,
    Math.floor(Date.now() / 1000),
    Math.floor(Date.now() / 1000),
  );
  const costTracker = new CostTracker(db, config.budget as any);
  const router = new BrainstormRouter(
    config as any,
    registry as any,
    costTracker,
  );

  // A real tool so finalTools is truthy (the nudge requires callable tools).
  const aiToolMap = {
    file_read: {
      description: "Read a file",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
  };
  const tools: any = {
    listTools: () => [
      {
        name: "file_read",
        description: "Read a file",
        permission: "auto",
        parameters: { type: "object", properties: {} },
      },
    ],
    list: () => [],
    get: () => undefined,
    filterByNames: () => [],
    toAISDKTools: () => aiToolMap,
    toAISDKToolsFiltered: () => aiToolMap,
    toAISDKToolsWithPermissions: () => aiToolMap,
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
    sessionId,
  };
}

/** A turn that only narrates a tool action and stops — no tool call. */
const narrationParts: any[] = [
  { type: "text-delta", delta: "Let me read config.ts to find the setting." },
  { type: "finish", finishReason: "stop" },
];

/** A turn that calls a tool normally. */
function toolCallParts(): any[] {
  return [
    { type: "text-delta", delta: "Reading the file. " },
    { type: "tool-input-start", id: "1", toolName: "file_read" },
    {
      type: "tool-call",
      toolName: "file_read",
      input: { path: "/config.ts" },
    },
    {
      type: "tool-result",
      toolName: "file_read",
      input: { path: "/config.ts" },
      output: { ok: true },
    },
    { type: "finish", finishReason: "stop" },
  ];
}

/** A legitimate plain-text final answer with no tool intent. */
const plainAnswerParts: any[] = [
  { type: "text-delta", delta: "The answer is 42." },
  { type: "finish", finishReason: "stop" },
];

/** A turn that writes a file (populates filesWritten for verify). */
function editTurnParts(path: string): any[] {
  return [
    { type: "text-delta", delta: "Editing the file. " },
    { type: "tool-input-start", id: "1", toolName: "file_write" },
    {
      type: "tool-call",
      toolName: "file_write",
      input: { path, content: "x" },
    },
    {
      type: "tool-result",
      toolName: "file_write",
      input: { path, content: "x" },
      output: { ok: true },
    },
    { type: "finish", finishReason: "stop" },
  ];
}

async function collectEvents(ctx: RunContext, opts: any = {}) {
  const events: Array<{ type: string; [k: string]: any }> = [];
  const gen = runAgentLoop(
    [{ role: "user" as const, content: "Find the setting" }],
    {
      config: ctx.config as any,
      registry: ctx.registry as any,
      router: ctx.router,
      costTracker: ctx.costTracker,
      tools: ctx.tools as any,
      sessionId: ctx.sessionId,
      projectPath: ctx.tmpProjectPath,
      systemPrompt: "You are a test agent.",
      preferredModelId: "anthropic/claude-sonnet-4.6",
      trajectoryEnabled: false,
      ...opts,
    } as any,
  );
  for await (const ev of gen) {
    events.push(ev as any);
    if (events.length > 80) break;
  }
  return events;
}

function passOutcome(): VerifyOutcome {
  return {
    ran: true,
    ok: true,
    diagnostics: "",
    typecheckPassed: true,
    testPassed: null,
  };
}

describe("agent loop — Phase 7 tool-use enforcement", () => {
  let ctx: RunContext;
  beforeEach(() => {
    _finishReason = "stop";
    ctx = buildContext();
    vi.mocked(streamText).mockClear();
  });
  afterEach(() => ctx.cleanup());

  it("(1) narration with no tool call triggers ONE nudge + forced toolChoice retry", async () => {
    // Turn 1 narrates (nudge); turn 2 calls the tool (satisfies, stops).
    _streamQueue = [narrationParts, toolCallParts()];

    const events = await collectEvents(ctx, {
      toolEnforcement: { enabled: true, maxNudges: 2 },
    });

    // Exactly one corrective re-prompt → two streamText calls.
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);

    const nudges = events.filter((e) => e.type === "tool-nudge");
    expect(nudges).toHaveLength(1);
    expect(nudges[0].iteration).toBe(1);

    // The corrective retry forced a real tool call.
    const secondCall = vi.mocked(streamText).mock.calls[1][0] as any;
    expect(secondCall.toolChoice).toBe("required");

    // And the correction was fed back as a user-role message.
    const fed = secondCall.messages as Array<{ role: string; content: any }>;
    expect(
      fed.some(
        (m) =>
          typeof m.content === "string" &&
          m.content.includes("[tool-enforcement]"),
      ),
    ).toBe(true);

    // The first call did NOT force toolChoice (normal turn).
    const firstCall = vi.mocked(streamText).mock.calls[0][0] as any;
    expect(firstCall.toolChoice).toBeUndefined();

    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("(2) a turn that calls a tool normally is untouched (no nudge)", async () => {
    _streamQueue = [toolCallParts()];

    const events = await collectEvents(ctx, {
      toolEnforcement: { enabled: true, maxNudges: 2 },
    });

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "tool-nudge")).toBe(false);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("(3) a legitimate plain-text final answer is NOT nudged", async () => {
    _streamQueue = [plainAnswerParts];

    const events = await collectEvents(ctx, {
      toolEnforcement: { enabled: true, maxNudges: 2 },
    });

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "tool-nudge")).toBe(false);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("(4) maxNudges caps the re-prompts (no infinite loop)", async () => {
    // Model narrates on EVERY turn — only the cap can stop it.
    _streamQueue = [narrationParts];

    const events = await collectEvents(ctx, {
      toolEnforcement: { enabled: true, maxNudges: 2 },
    });

    // depth0 nudge→turn1; depth1 nudge→turn2; depth2: 2<2 false → stop.
    // streamText: initial + 2 nudges = 3.
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === "tool-nudge")).toHaveLength(2);
    // Still terminates cleanly.
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("(5) enabled:false is a pure no-op", async () => {
    _streamQueue = [narrationParts];

    const events = await collectEvents(ctx, {
      toolEnforcement: { enabled: false, maxNudges: 2 },
    });

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "tool-nudge")).toBe(false);
    // No forced toolChoice anywhere.
    const call = vi.mocked(streamText).mock.calls[0][0] as any;
    expect(call.toolChoice).toBeUndefined();
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("(6) composes with verify without compounding into an unbounded loop", async () => {
    // Turn 1 narrates (nudge, forced retry). Turn 2 EDITS a file — which
    // satisfies enforcement (a tool WAS called) and then triggers verify.
    // Verify passes, so the run ends. The two mechanisms must not stack.
    _streamQueue = [narrationParts, editTurnParts("/src/x.ts")];
    const runner = vi.fn(() => passOutcome());

    const events = await collectEvents(ctx, {
      toolEnforcement: { enabled: true, maxNudges: 2 },
      verify: { mode: "typecheck", maxIterations: 2 },
      _verifyRunner: runner,
    });

    // 1 nudge (turn1→turn2) + verify passes on turn2 (no further turn).
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.type === "tool-nudge")).toHaveLength(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "verify-passed")).toBe(true);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});
