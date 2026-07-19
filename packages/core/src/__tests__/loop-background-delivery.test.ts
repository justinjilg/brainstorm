import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Deferred synthesis control ─────────────────────────────────────────────
// The loop's forced-synthesis turn awaits streamText().text. We hand it a
// promise we resolve manually, so the test can inject a background completion
// into the loop's (still-registered) handler DURING the synthesis window —
// i.e. after the loop's last queue drain but before its `finally`. That is the
// exact turn-tail race the mailbox fix addresses.
let _synthTextResolve: ((v: string) => void) | null = null;
let _synthGate: Promise<void> | null = null;
let _synthGateResolve: (() => void) | null = null;
let _callIndex = 0;

vi.mock("ai", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    streamText: vi.fn((opts: any) => {
      const isSynthesis = _callIndex === 1;
      _callIndex++;
      // Call 0 (tool work): make a tool call, hit the cap, emit no final text.
      if (!isSynthesis) {
        if (opts.onStepFinish) {
          for (let i = 0; i < 2; i++) {
            opts.onStepFinish({
              usage: { inputTokens: 5, outputTokens: 2 },
              finishReason: "tool-calls",
            });
          }
        }
        async function* toolStream() {
          yield { type: "tool-input-start", id: "1", toolName: "file_read" };
          yield { type: "tool-call", toolName: "file_read", input: { path: "/x" } };
          yield { type: "tool-result", toolName: "file_read", output: "contents" };
          yield { type: "finish", finishReason: "tool-calls" };
        }
        return {
          fullStream: toolStream(),
          textStream: (async function* () {})(),
          text: Promise.resolve(""),
          usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
          finishReason: Promise.resolve("tool-calls"),
          response: Promise.resolve({ headers: new Map() }),
        };
      }
      // Call 1 (synthesis): text is a deferred promise the test resolves after
      // injecting a background completion. Signal readiness via _synthGate.
      if (opts.onStepFinish) {
        opts.onStepFinish({
          usage: { inputTokens: 5, outputTokens: 2 },
          finishReason: "stop",
        });
      }
      const textPromise = new Promise<string>((res) => {
        _synthTextResolve = res;
      });
      _synthGateResolve?.();
      return {
        fullStream: (async function* () {})(),
        textStream: (async function* () {})(),
        text: textPromise,
        usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
        finishReason: Promise.resolve("stop"),
        response: Promise.resolve({ headers: new Map() }),
      };
    }),
  };
});

// Capture the background-completion handler the loop registers, so the test can
// deliver a "late" completion to it during the synthesis window.
let _capturedBgHandler: ((e: any) => void) | null = null;
const _requeueSpy = vi.fn();

vi.mock("@brainst0rm/tools", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    setBackgroundEventHandler: (handler: any, sessionId?: string) => {
      if (handler) _capturedBgHandler = handler;
      return actual.setBackgroundEventHandler(handler, sessionId);
    },
    requeueBackgroundEvents: (events: any, sessionId?: string) => {
      _requeueSpy(events, sessionId);
      return actual.requeueBackgroundEvents(events, sessionId);
    },
  };
});

import { runAgentLoop } from "../agent/loop.js";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { getTestDb } from "@brainst0rm/db";
import {
  setBackgroundEventHandler,
  withSession,
} from "@brainst0rm/tools";
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

describe("loop hands off turn-tail background completions (mailbox)", () => {
  beforeEach(() => {
    _callIndex = 0;
    _capturedBgHandler = null;
    _synthTextResolve = null;
    _requeueSpy.mockClear();
    _synthGate = new Promise<void>((res) => {
      _synthGateResolve = res;
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("a completion arriving during synthesis is not lost — it replays next turn", async () => {
    const tmpProjectPath = mkdtempSync(join(tmpdir(), "brainstorm-bgd-"));
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
      routing: { rules: [], fallbackModels: [] },
      shell: { defaultTimeout: 60000, maxOutputBytes: 50000 },
    };
    const registry: any = {
      models: [model],
      getModel: (id: string) => (id === model.id ? model : undefined),
      getProvider: () => ({}),
    };
    const db = getTestDb();
    const sessionId = "bgd-session";
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

    try {
      // Drive the loop; concurrently, once synthesis begins, inject a late
      // background completion into the loop's handler, then let synthesis finish.
      const consume = (async () => {
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
            disableTools: false,
            trajectoryEnabled: false,
          } as any,
        )) {
          events.push(ev);
          if (events.length > 60) break;
        }
        return events;
      })();

      // Wait until synthesis has started (handler is registered, loop past its
      // last drain), inject the late completion, then release synthesis.
      await _synthGate;
      expect(_capturedBgHandler).toBeTypeOf("function");
      _capturedBgHandler!({
        taskId: "bg-late",
        command: "sleep 1 && echo done",
        exitCode: 0,
        stdout: "done\n",
        stderr: "",
      });
      _synthTextResolve!("Final synthesized answer.");

      const events = await consume;

      // The turn completed with the synthesized answer...
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      // ...and the loop handed the late completion to the mailbox (not dropped).
      expect(_requeueSpy).toHaveBeenCalledTimes(1);
      const [requeued, reqSession] = _requeueSpy.mock.calls[0];
      expect(reqSession).toBe(sessionId);
      expect(requeued).toHaveLength(1);
      expect(requeued[0].taskId).toBe("bg-late");

      // Next turn in the SAME session replays it (real end-to-end delivery).
      const replayed: string[] = [];
      withSession(sessionId, () =>
        setBackgroundEventHandler((e) => replayed.push(e.taskId)),
      );
      expect(replayed).toEqual(["bg-late"]);
      withSession(sessionId, () => setBackgroundEventHandler(null));
    } finally {
      rmSync(tmpProjectPath, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome) process.env.HOME = originalHome;
    }
  });
});
