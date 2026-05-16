/**
 * P9d-2 — Agent-loop end-to-end chaos.
 *
 * PR #322 closed the BR-down chaos surface at the fetch-wrapper layer
 * (packages/providers/src/__tests__/br-down-chaos.test.ts: 9 tests).
 * That covers what happens *before* the AI SDK sees the response.
 * This file covers what happens *after* — when streamText itself throws,
 * yields an error mid-stream, or the caller aborts.
 *
 * The agent loop classifies failures into 5 buckets
 * (packages/core/src/agent/loop.ts:1345-1418):
 *
 *   1. AbortError / signal.aborted    → event { type: "interrupted" }
 *   2. isModelApiError(err)           → event { type: "error", category: "model-api" }
 *   3. isDbError(err)                 → event { type: "error", category: "database" }
 *   4. err.middleware                 → event { type: "error", category: "middleware" }
 *   5. anything else                  → event { type: "error", category: "unknown" }
 *
 * Every branch reaches the same `finally` block, which is where
 * trajectory submission + routing-outcome recording happens. A test
 * that hits all five branches gives us confidence the loop doesn't
 * leak resources on any failure shape and the operator sees a typed
 * event they can route on.
 *
 * Scaffold mirrors e2e-pipeline.test.ts so the diff against the
 * existing pattern is mechanical.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Module-level state that each test mutates to control streamText's
// behaviour. Reset in beforeEach.
let _streamTextBehaviour:
  | { kind: "throws-sync"; err: any }
  | { kind: "fullStream-throws"; err: any }
  | { kind: "abort-from-options" }
  | { kind: "ok" } = { kind: "ok" };

vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamText: vi.fn((opts: any) => {
      const behaviour = _streamTextBehaviour;
      if (behaviour.kind === "throws-sync") {
        // Pre-stream failure — e.g. network refused before bytes arrived.
        // The loop's outer try/catch must classify and emit.
        throw behaviour.err;
      }

      if (behaviour.kind === "abort-from-options") {
        // Simulate caller aborting before the stream starts.
        const abortErr: any = new Error("aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }

      const events =
        behaviour.kind === "fullStream-throws"
          ? null
          : [
              { type: "text-delta", delta: "Hello " },
              { type: "finish", finishReason: "stop" },
            ];

      if (opts.onStepFinish && events) {
        setImmediate(() => {
          opts.onStepFinish({
            usage: { inputTokens: 5, outputTokens: 2 },
            finishReason: "stop",
          });
        });
      }

      async function* fullStream() {
        if (behaviour.kind === "fullStream-throws") {
          // Mid-stream rupture — partial bytes then error.
          yield { type: "text-delta", delta: "partial " };
          throw behaviour.err;
        }
        for (const ev of events!) yield ev;
      }

      async function* textStream() {
        if (behaviour.kind === "fullStream-throws") {
          yield "partial ";
          throw behaviour.err;
        }
        yield "Hello ";
      }

      return {
        fullStream: fullStream(),
        textStream: textStream(),
        text: Promise.resolve("Hello "),
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
        finishReason: Promise.resolve("stop"),
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
  const tmpProjectPath = mkdtempSync(join(tmpdir(), "brainstorm-chaos-"));
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
    routing: { rules: [] } as any,
    shell: { defaultTimeout: 60000, maxOutputBytes: 50000 } as any,
  };

  const fakeModel: ModelEntry = {
    id: "fake/chaos-model",
    provider: "fake",
    name: "Fake Chaos Model",
    capabilities: {
      toolCalling: true,
      streaming: true,
      vision: false,
      reasoning: false,
      contextWindow: 8000,
      qualityTier: 2,
      speedTier: 1,
      bestFor: ["conversation"],
    },
    pricing: { inputPer1MTokens: 0.1, outputPer1MTokens: 0.2 },
    limits: { contextWindow: 8000, maxOutputTokens: 2000 },
    status: "available",
    isLocal: false,
    lastHealthCheck: 0,
  };

  const registry: Partial<ProviderRegistry> = {
    models: [fakeModel],
    getModel: (id: string) => (id === fakeModel.id ? fakeModel : undefined),
    getProvider: () => ({}) as any,
  };

  const db = getTestDb();
  const sessionId = `chaos-${Math.random().toString(36).slice(2, 8)}`;
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
  const gen = runAgentLoop([{ role: "user" as const, content: "Say hello" }], {
    config: ctx.config as any,
    registry: ctx.registry as any,
    router: ctx.router,
    costTracker: ctx.costTracker,
    tools: ctx.tools as any,
    sessionId: ctx.sessionId,
    projectPath: ctx.tmpProjectPath,
    systemPrompt: "You are a test agent.",
    disableTools: true,
    trajectoryEnabled: false,
    ...opts,
  } as any);
  for await (const ev of gen) {
    events.push(ev as any);
    if (events.length > 50) break;
  }
  return events;
}

describe("agent loop — chaos classifications (P9d-2)", () => {
  let ctx: RunContext;
  beforeEach(() => {
    _streamTextBehaviour = { kind: "ok" };
    ctx = buildContext();
  });
  afterEach(() => {
    ctx.cleanup();
  });

  it("classifies streamText fetch-failed as model-api error", async () => {
    _streamTextBehaviour = {
      kind: "throws-sync",
      err: Object.assign(new Error("fetch failed"), { statusCode: 503 }),
    };
    const events = await collectEvents(ctx);
    const err = events.find((e) => e.type === "error");
    expect(err, "loop must emit a typed error event").toBeDefined();
    expect(err!.category).toBe("model-api");
  });

  it("classifies rate-limit (429) as model-api error", async () => {
    _streamTextBehaviour = {
      kind: "throws-sync",
      err: Object.assign(new Error("rate limit exceeded — 429"), {
        statusCode: 429,
      }),
    };
    const events = await collectEvents(ctx);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.category).toBe("model-api");
  });

  it("emits interrupted (not error) when AbortError is thrown", async () => {
    _streamTextBehaviour = { kind: "abort-from-options" };
    const events = await collectEvents(ctx);
    const interrupted = events.find((e) => e.type === "interrupted");
    expect(
      interrupted,
      "AbortError must NOT be classified as error",
    ).toBeDefined();
    const err = events.find((e) => e.type === "error");
    expect(err).toBeUndefined();
  });

  it("classifies mid-stream rupture (model API) as model-api error", async () => {
    _streamTextBehaviour = {
      kind: "fullStream-throws",
      err: Object.assign(new Error("503 service unavailable"), {
        statusCode: 503,
      }),
    };
    const events = await collectEvents(ctx);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.category).toBe("model-api");
  });

  it("classifies SQLITE_FULL as database error (not model failure)", async () => {
    _streamTextBehaviour = {
      kind: "throws-sync",
      err: Object.assign(new Error("disk i/o error"), {
        code: "SQLITE_FULL",
      }),
    };
    const events = await collectEvents(ctx);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.category).toBe("database");
    // Operator-facing message must mention disk/permissions, not the model.
    expect(err!.error.message.toLowerCase()).toMatch(/disk|permission/);
  });

  it("classifies middleware-tagged error from streamText path as middleware category", async () => {
    const middlewareErr: any = new Error("blocked by content policy");
    middlewareErr.middleware = "content-policy";
    middlewareErr.reason = "prompt contains prohibited pattern";
    _streamTextBehaviour = { kind: "throws-sync", err: middlewareErr };
    const events = await collectEvents(ctx);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.category).toBe("middleware");
    expect(err!.error.message).toContain("content-policy");
  });

  it("classifies pre-stream middleware throw (beforeAgent) as middleware category", async () => {
    // Codex finding (PR #325 MAJOR #1): runBeforeAgent runs BEFORE the
    // classified try/catch. A throw here would historically escape the
    // generator unclassified. After the fix, the same category=middleware
    // event must surface so consumers can route on it identically to
    // mid-stream middleware blocks.
    const throwingMiddleware: any = {
      runBeforeAgent: () => {
        const e: any = new Error("policy violation: secrets in prompt");
        e.middleware = "secret-scanner";
        e.reason = "API key pattern detected";
        throw e;
      },
      runBeforeTool: () => ({ allow: true }),
      runAfterTool: () => {},
      runAfterAgent: () => {},
    };
    _streamTextBehaviour = { kind: "ok" };
    const events = await collectEvents(ctx, { middleware: throwingMiddleware });
    const err = events.find((e) => e.type === "error");
    expect(
      err,
      "pre-stream middleware throw must emit a typed event",
    ).toBeDefined();
    expect(err!.category).toBe("middleware");
    expect(err!.error.message).toContain("secret-scanner");
    expect(err!.error.message).toContain("API key pattern detected");
    // The loop must NOT have proceeded to a streamText call after the
    // middleware blocked — no text-delta events should appear.
    const deltas = events.filter((e) => e.type === "text-delta");
    expect(deltas).toHaveLength(0);
  });

  it("untagged pre-stream middleware throw still emits a middleware event with generic label", async () => {
    // The .middleware tag is conventional; we should still classify
    // correctly when middleware throws an untagged Error.
    const throwingMiddleware: any = {
      runBeforeAgent: () => {
        throw new Error("validator crashed");
      },
      runBeforeTool: () => ({ allow: true }),
      runAfterTool: () => {},
      runAfterAgent: () => {},
    };
    const events = await collectEvents(ctx, { middleware: throwingMiddleware });
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.category).toBe("middleware");
    expect(err!.error.message).toContain("beforeAgent");
  });

  it("classifies generic unknown error as unknown category", async () => {
    _streamTextBehaviour = {
      kind: "throws-sync",
      err: new Error("something went wrong in a way we did not anticipate"),
    };
    const events = await collectEvents(ctx);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!.category).toBe("unknown");
  });
});
