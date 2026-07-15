/**
 * Phase 3 — in-loop verify / self-correction.
 *
 * After an edit-producing turn, the agent loop runs a VERIFY pass over the
 * files changed THIS turn. On failure it feeds diagnostics back as another
 * turn so the model self-corrects within the same run; on success it continues
 * normally. These tests drive a scripted fullStream that "writes" a file (so
 * `filesWritten` is populated) and inject a MOCK verifier to prove:
 *
 *   (a) a passing verify does NOT add a turn,
 *   (b) a failing verify feeds diagnostics back and offers another turn,
 *   (c) the iteration budget caps self-correction,
 *   (d) mode=off is a pure no-op (verifier never invoked),
 *   (e) a verifier that THROWS degrades gracefully (turn still completes).
 *
 * Scaffold mirrors loop-tool-calling.test.ts so the diff is mechanical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const tmpProjectPath = mkdtempSync(join(tmpdir(), "brainstorm-verify-"));
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
      // Note: verify is supplied per-invocation via opts.verify, so the raw
      // (un-parsed) config here intentionally omits it — the loop falls back
      // to "off" when neither is present (proving the off default is safe).
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
  const sessionId = `verify-${Math.random().toString(36).slice(2, 8)}`;
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

/** A turn that writes a file — populates the loop's `filesWritten` set. */
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
      preferredModelId: "anthropic/claude-sonnet-4.6",
      disableTools: true,
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

function failOutcome(): VerifyOutcome {
  return {
    ran: true,
    ok: false,
    diagnostics:
      "src/x.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    typecheckPassed: false,
    testPassed: null,
  };
}

describe("agent loop — Phase 3 in-loop verify", () => {
  let ctx: RunContext;
  beforeEach(() => {
    _streamParts = editTurnParts("/src/x.ts");
    _finishReason = "stop";
    ctx = buildContext();
    vi.mocked(streamText).mockClear();
  });
  afterEach(() => ctx.cleanup());

  it("(a) a passing verify does not add a turn", async () => {
    const runner = vi.fn(() => passOutcome());
    const events = await collectEvents(ctx, {
      verify: { mode: "typecheck", maxIterations: 2 },
      _verifyRunner: runner,
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1); // no extra turn
    expect(events.some((e) => e.type === "verify-passed")).toBe(true);
    expect(events.some((e) => e.type === "verify-failed")).toBe(false);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("(b) a failing verify feeds diagnostics back and offers another turn", async () => {
    // Pass on the SECOND invocation so the run terminates after one correction.
    const runner = vi
      .fn<() => VerifyOutcome>()
      .mockReturnValueOnce(failOutcome())
      .mockReturnValue(passOutcome());

    const events = await collectEvents(ctx, {
      verify: { mode: "typecheck", maxIterations: 3 },
      _verifyRunner: runner,
    });

    // A second model turn was offered (recursion → streamText again).
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);

    const failed = events.find((e) => e.type === "verify-failed");
    expect(failed, "must surface a verify-failed diagnostic").toBeDefined();
    expect(failed!.diagnostics).toMatch(/TS2322/);
    expect(failed!.iteration).toBe(1);

    // The diagnostic must have been fed back to the model as a correction turn.
    const secondCall = vi.mocked(streamText).mock.calls[1][0] as any;
    const fedMessages = secondCall.messages as Array<{
      role: string;
      content: any;
    }>;
    const hasVerifyMsg = fedMessages.some(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("[verify]") &&
        m.content.includes("TS2322"),
    );
    expect(hasVerifyMsg, "correction turn must carry the diagnostics").toBe(
      true,
    );

    // Terminates cleanly after the correction passes.
    expect(events.some((e) => e.type === "verify-passed")).toBe(true);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("(c) the iteration budget caps self-correction", async () => {
    // Verifier ALWAYS fails — only the maxIterations cap can stop the loop.
    const runner = vi.fn(() => failOutcome());

    const events = await collectEvents(ctx, {
      verify: { mode: "typecheck", maxIterations: 2 },
      _verifyRunner: runner,
    });

    // depth0 verify(fail)→turn1; depth1 verify(fail)→turn2; depth2: 2<2 false → stop.
    // streamText: initial + 2 corrections = 3.
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(3);
    expect(runner).toHaveBeenCalledTimes(2); // capped, not infinite
    expect(events.filter((e) => e.type === "verify-failed")).toHaveLength(2);
    // The run still terminates.
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("(d) mode=off is a pure no-op", async () => {
    const runner = vi.fn(() => failOutcome());
    const events = await collectEvents(ctx, {
      verify: { mode: "off", maxIterations: 2 },
      _verifyRunner: runner,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type.startsWith("verify-"))).toBe(false);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("(d.2) a no-op (no files changed) turn skips verify entirely", async () => {
    // A turn with only text and no file_write → filesWritten empty.
    _streamParts = [
      { type: "text-delta", delta: "Just talking, no edits." },
      { type: "finish", finishReason: "stop" },
    ];
    const runner = vi.fn(() => failOutcome());
    const events = await collectEvents(ctx, {
      verify: { mode: "typecheck", maxIterations: 2 },
      _verifyRunner: runner,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type.startsWith("verify-"))).toBe(false);
  });

  it("(e) a verifier that throws degrades gracefully", async () => {
    const runner = vi.fn(() => {
      throw new Error("tsc exploded");
    });
    const events = await collectEvents(ctx, {
      verify: { mode: "typecheck", maxIterations: 2 },
      _verifyRunner: runner,
    });

    // The thrown error is swallowed inside runVerifyPass → skip. The turn
    // must still complete without an error event or an extra turn.
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "verify-failed")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });
});
