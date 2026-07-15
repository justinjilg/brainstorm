/**
 * Agent-loop tool-calling robustness.
 *
 * Two concerns, both exercised end-to-end against a scripted fullStream:
 *
 *   1. INBOUND tool-name reverse mapping — when a non-Anthropic model emits a
 *      tool call under its provider-native name (OpenAI apply_patch/read_file,
 *      Google replace, …), the loop must translate it BACK to the canonical
 *      name before tracking/dispatch. Otherwise every canonical comparison
 *      (file_read/file_write/shell/subagent) and the executor lookup miss.
 *
 *   2. Truncated tool-call detection — a duplicate/malformed terminal finish
 *      (seen from BR) can cut the AI-SDK parser off mid-tool-call, leaving a
 *      pending tool call that never dispatches. The loop must NOT record this
 *      as a silent empty-success: it must surface a diagnostic and route to
 *      the retry/fallback path, distinguished from a genuinely empty turn.
 *
 * Scaffold mirrors loop-chaos.test.ts so the diff is mechanical.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scripted fullStream parts + terminal finish reason for each test.
let _streamParts: any[] = [];
let _finishReason = "stop";

vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamText: vi.fn((opts: any) => {
      if (opts.onStepFinish) {
        setImmediate(() => {
          opts.onStepFinish({
            usage: { inputTokens: 5, outputTokens: 2 },
            finishReason: _finishReason,
          });
        });
      }
      async function* fullStream() {
        for (const ev of _streamParts) yield ev;
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

import { runAgentLoop } from "../agent/loop.js";
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
  const tmpProjectPath = mkdtempSync(join(tmpdir(), "brainstorm-toolcall-"));
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
    } as any,
    budget: { hardLimit: false } as any,
    // Empty fallback list so a truncated/empty turn can't recurse into
    // another streamText call — keeps these tests single-shot.
    routing: { rules: [], fallbackModels: [] } as any,
    shell: { defaultTimeout: 60000, maxOutputBytes: 50000 } as any,
  };

  // OpenAI-family model so the loop's reverse tool-name map is active.
  const openaiModel: ModelEntry = {
    id: "openai/gpt-5.4",
    provider: "openai",
    name: "GPT-5.4",
    capabilities: {
      toolCalling: true,
      streaming: true,
      vision: false,
      reasoning: false,
      contextWindow: 128000,
      qualityTier: 3,
      speedTier: 2,
      bestFor: ["code-generation"],
    },
    pricing: { inputPer1MTokens: 1, outputPer1MTokens: 3 },
    limits: { contextWindow: 128000, maxOutputTokens: 4000 },
    status: "available",
    isLocal: false,
    lastHealthCheck: 0,
  };

  const registry: Partial<ProviderRegistry> = {
    models: [openaiModel],
    getModel: (id: string) => (id === openaiModel.id ? openaiModel : undefined),
    getProvider: () => ({}) as any,
  };

  const db = getTestDb();
  const sessionId = `toolcall-${Math.random().toString(36).slice(2, 8)}`;
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
    config,
    registry,
    router,
    costTracker,
    tools,
    tmpProjectPath,
    sessionId,
  };
}

async function collectEvents(ctx: RunContext, opts: any = {}) {
  const events: Array<{ type: string; [k: string]: any }> = [];
  const gen = runAgentLoop(
    [{ role: "user" as const, content: "Edit the file" }],
    {
      config: ctx.config as any,
      registry: ctx.registry as any,
      router: ctx.router,
      costTracker: ctx.costTracker,
      tools: ctx.tools as any,
      sessionId: ctx.sessionId,
      projectPath: ctx.tmpProjectPath,
      systemPrompt: "You are a test agent.",
      preferredModelId: "openai/gpt-5.4",
      disableTools: true,
      trajectoryEnabled: false,
      ...opts,
    } as any,
  );
  for await (const ev of gen) {
    events.push(ev as any);
    if (events.length > 50) break;
  }
  return events;
}

describe("agent loop — inbound tool-name reverse mapping", () => {
  let ctx: RunContext;
  beforeEach(() => {
    _streamParts = [];
    _finishReason = "stop";
    ctx = buildContext();
  });
  afterEach(() => ctx.cleanup());

  it("surfaces a provider-renamed tool call under its canonical name", async () => {
    // OpenAI renames file_edit → apply_patch outbound. The model emits the
    // renamed name; the loop must reverse it to file_edit for its events.
    _streamParts = [
      { type: "tool-input-start", id: "1", toolName: "apply_patch" },
      {
        type: "tool-call",
        toolName: "apply_patch",
        input: { path: "/x.ts", patch: "..." },
      },
      {
        type: "tool-result",
        toolName: "apply_patch",
        output: { ok: true },
      },
      { type: "finish", finishReason: "tool-calls" },
    ];
    _finishReason = "tool-calls";
    const events = await collectEvents(ctx);

    const start = events.find((e) => e.type === "tool-call-start");
    expect(start, "tool-call-start must be emitted").toBeDefined();
    expect(start!.toolName).toBe("file_edit");

    const result = events.find((e) => e.type === "tool-call-result");
    expect(result, "tool-call-result must be emitted").toBeDefined();
    expect(result!.toolName).toBe("file_edit");

    // A completed tool-call under finishReason=tool-calls is NOT truncated.
    expect(events.some((e) => e.type === "fallback-exhausted")).toBe(false);
  });

  it("reverse-maps read_file → file_read for turn-context tracking", async () => {
    _streamParts = [
      { type: "tool-input-start", id: "1", toolName: "read_file" },
      {
        type: "tool-call",
        toolName: "read_file",
        input: { path: "/src/a.ts" },
      },
      {
        type: "tool-result",
        toolName: "read_file",
        input: { path: "/src/a.ts" },
        output: "file contents",
      },
      { type: "finish", finishReason: "tool-calls" },
    ];
    _finishReason = "tool-calls";
    let capturedTurn: any;
    const events = await collectEvents(ctx, {
      onTurnComplete: (t: any) => {
        capturedTurn = t;
      },
    });

    const result = events.find((e) => e.type === "tool-call-result");
    expect(result!.toolName).toBe("file_read");
    // Canonical name must reach turn context so filesRead tracks the path.
    expect(capturedTurn?.filesRead).toContain("/src/a.ts");
    expect(capturedTurn?.toolCalls?.[0]?.name).toBe("file_read");
  });
});

describe("agent loop — truncated tool-call detection", () => {
  let ctx: RunContext;
  beforeEach(() => {
    _streamParts = [];
    _finishReason = "stop";
    ctx = buildContext();
  });
  afterEach(() => ctx.cleanup());

  it("detects a pending tool-call that never completed (truncation)", async () => {
    // tool-input-start with NO matching tool-call — parser cut off mid-call.
    _streamParts = [
      { type: "text-delta", delta: "Let me edit that. " },
      { type: "tool-input-start", id: "1", toolName: "apply_patch" },
      { type: "finish", finishReason: "tool-calls" },
    ];
    _finishReason = "tool-calls";
    const events = await collectEvents(ctx);

    const warning = events.find(
      (e) => e.type === "loop-warning" && /truncat/i.test(e.message),
    );
    expect(warning, "must surface a truncation diagnostic").toBeDefined();

    // Must route to the retry path and, with no fallbacks, exhaust it — with
    // a reason distinct from the empty-turn reason.
    const exhausted = events.find((e) => e.type === "fallback-exhausted");
    expect(exhausted, "truncation must not be a silent success").toBeDefined();
    expect(exhausted!.reason).toMatch(/truncat/i);
  });

  it("detects finishReason=tool-calls with zero tool-calls as truncation", async () => {
    // No tool-input-start at all, but the provider claims it stopped to call
    // tools — a malformed/duplicate finish that dropped the tool-call parts.
    _streamParts = [
      { type: "text-delta", delta: "Working on it. " },
      { type: "finish", finishReason: "tool-calls" },
      { type: "finish", finishReason: "tool-calls" }, // duplicate terminal finish
    ];
    _finishReason = "tool-calls";
    const events = await collectEvents(ctx);

    const exhausted = events.find((e) => e.type === "fallback-exhausted");
    expect(exhausted).toBeDefined();
    expect(exhausted!.reason).toMatch(/truncat/i);
  });

  it("distinguishes a genuinely empty turn from truncation", async () => {
    // No text, no tool intent, clean stop — this is empty, not truncated.
    _streamParts = [{ type: "finish", finishReason: "stop" }];
    _finishReason = "stop";
    const events = await collectEvents(ctx);

    const exhausted = events.find((e) => e.type === "fallback-exhausted");
    expect(exhausted).toBeDefined();
    expect(exhausted!.reason).toMatch(/empty/i);
    expect(exhausted!.reason).not.toMatch(/truncat/i);
    // No truncation diagnostic for a genuinely empty turn.
    expect(
      events.some(
        (e) => e.type === "loop-warning" && /truncat/i.test(e.message),
      ),
    ).toBe(false);
  });

  it("does not flag a normal completed tool-call as truncated", async () => {
    _streamParts = [
      { type: "tool-input-start", id: "1", toolName: "apply_patch" },
      { type: "tool-call", toolName: "apply_patch", input: { path: "/x" } },
      { type: "tool-result", toolName: "apply_patch", output: { ok: true } },
      { type: "finish", finishReason: "tool-calls" },
    ];
    _finishReason = "tool-calls";
    const events = await collectEvents(ctx);
    expect(events.some((e) => e.type === "fallback-exhausted")).toBe(false);
    expect(
      events.some(
        (e) => e.type === "loop-warning" && /truncat/i.test(e.message),
      ),
    ).toBe(false);
  });
});
