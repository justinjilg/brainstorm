import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { getTestDb } from "@brainst0rm/db";
import type { AgentEvent } from "@brainst0rm/shared";
import { IntakeCoordinator } from "../coordinator.js";
import type { CoordinatorDependencies } from "../coordinator.js";
import type { InboundMessage, OutboundSink } from "../types.js";

// ── Fakes ────────────────────────────────────────────────────────────────

interface SessionKey {
  channelType: string;
  teamId?: string;
  channelId: string;
  threadKey: string;
}

function keyStr(k: SessionKey): string {
  return [k.channelType, k.teamId ?? "", k.channelId, k.threadKey].join("|");
}

/** Fake ChannelSessionStore backed by a Map. */
class FakeSessionStore {
  private map = new Map<string, string>();
  readonly binds: Array<{ key: SessionKey; id: string }> = [];

  resolve(key: SessionKey): string | null {
    return this.map.get(keyStr(key)) ?? null;
  }
  bind(key: SessionKey, conversationId: string): void {
    this.map.set(keyStr(key), conversationId);
    this.binds.push({ key, id: conversationId });
  }
}

interface RecordingSink extends OutboundSink {
  finalizeCalls: Array<{
    placeholderId: string;
    markdown: string;
    meta: { cost: number; toolCalls: string[] };
  }>;
  errorCalls: Array<{ placeholderId: string | null; error: string }>;
  placeholderCount: number;
}

function makeSink(order?: string[]): RecordingSink {
  const finalizeCalls: RecordingSink["finalizeCalls"] = [];
  const errorCalls: RecordingSink["errorCalls"] = [];
  let placeholderCount = 0;
  const sink: RecordingSink = {
    finalizeCalls,
    errorCalls,
    get placeholderCount() {
      return placeholderCount;
    },
    async postPlaceholder() {
      order?.push("placeholder");
      placeholderCount++;
      return "ph-1";
    },
    async finalize(_msg, placeholderId, markdown, meta) {
      order?.push("finalize");
      finalizeCalls.push({ placeholderId, markdown, meta });
    },
    async postError(_msg, placeholderId, error) {
      order?.push("error");
      errorCalls.push({ placeholderId, error });
    },
  };
  return sink;
}

/** Build a fake runLoop from a fixed event script. */
function scriptedLoop(
  events: AgentEvent[],
  onCall?: (messages: any[], options: any) => void,
): CoordinatorDependencies["runLoop"] {
  return async function* (messages: any, options: any) {
    onCall?.(messages, options);
    for (const e of events) yield e;
  } as unknown as CoordinatorDependencies["runLoop"];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let projectPath: string;

beforeAll(() => {
  projectPath = mkdtempSync(join(tmpdir(), "channels-coord-"));
});
afterAll(() => {
  rmSync(projectPath, { recursive: true, force: true });
});

function makeMsg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelType: "slack",
    teamId: "T1",
    channelId: "C1",
    threadKey: "thread-1",
    userId: "U1",
    text: "what changed?",
    ...over,
  };
}

function makeDeps(
  over: Partial<CoordinatorDependencies> = {},
): CoordinatorDependencies {
  return {
    db: over.db ?? ({} as Database.Database),
    config: {},
    registry: {} as any,
    router: {} as any,
    costTracker: {} as any,
    tools: {} as any,
    projectPath,
    sessionStore: over.sessionStore ?? (new FakeSessionStore() as any),
    runLoop: over.runLoop,
    // Hermetic seams: keep unit tests off the real system-prompt/middleware
    // builders (which touch on-disk project + memory state).
    buildSystemPrompt:
      over.buildSystemPrompt ?? ((() => ({ prompt: "BASE" })) as any),
    createMiddlewarePipeline:
      over.createMiddlewarePipeline ?? ((() => undefined) as any),
    ...over,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("IntakeCoordinator.handle", () => {
  it("posts the placeholder BEFORE consuming the loop, then finalizes", async () => {
    const order: string[] = [];
    const store = new FakeSessionStore();
    store.bind(
      {
        channelType: "slack",
        teamId: "T1",
        channelId: "C1",
        threadKey: "thread-1",
      },
      "sess-existing",
    );
    const loop = scriptedLoop(
      [
        { type: "text-delta", delta: "Nothing " },
        { type: "text-delta", delta: "changed." },
        { type: "done", totalCost: 0.01 },
      ],
      () => order.push("loop"),
    );
    const sink = makeSink(order);
    const coord = new IntakeCoordinator(
      makeDeps({ sessionStore: store as any, runLoop: loop }),
      { authority: "read-only" },
    );

    await coord.handle(makeMsg(), sink);

    expect(order).toEqual(["placeholder", "loop", "finalize"]);
  });

  it("finalize receives concatenated markdown, tool names, and cost", async () => {
    const store = new FakeSessionStore();
    store.bind(
      {
        channelType: "slack",
        teamId: "T1",
        channelId: "C1",
        threadKey: "thread-1",
      },
      "sess-existing",
    );
    const loop = scriptedLoop([
      { type: "text-delta", delta: "Ran " },
      { type: "tool-call-start", toolName: "git_status", args: {} },
      { type: "text-delta", delta: "a check." },
      { type: "done", totalCost: 0.25 },
    ]);
    const sink = makeSink();
    const coord = new IntakeCoordinator(
      makeDeps({ sessionStore: store as any, runLoop: loop }),
      { authority: "read-only" },
    );

    await coord.handle(makeMsg(), sink);

    expect(sink.finalizeCalls).toHaveLength(1);
    expect(sink.finalizeCalls[0].markdown).toBe("Ran a check.");
    expect(sink.finalizeCalls[0].placeholderId).toBe("ph-1");
    expect(sink.finalizeCalls[0].meta).toEqual({
      cost: 0.25,
      toolCalls: ["git_status"],
    });
  });

  it("passes a read-only authority note into the system prompt", async () => {
    const store = new FakeSessionStore();
    store.bind(
      {
        channelType: "slack",
        teamId: "T1",
        channelId: "C1",
        threadKey: "thread-1",
      },
      "sess-existing",
    );
    let seenSystemPrompt = "";
    const loop = scriptedLoop(
      [{ type: "done", totalCost: 0 }],
      (_msgs, options) => {
        seenSystemPrompt = options.systemPrompt;
      },
    );
    const coord = new IntakeCoordinator(
      makeDeps({ sessionStore: store as any, runLoop: loop }),
      { authority: "read-only" },
    );

    await coord.handle(makeMsg(), makeSink());

    expect(seenSystemPrompt).toContain("read-only");
    expect(seenSystemPrompt.toLowerCase()).toContain("would do");
  });

  it("calls postError and does not throw when the loop errors", async () => {
    const store = new FakeSessionStore();
    store.bind(
      {
        channelType: "slack",
        teamId: "T1",
        channelId: "C1",
        threadKey: "thread-1",
      },
      "sess-existing",
    );
    const loop = async function* () {
      throw new Error("model exploded");
      // eslint-disable-next-line no-unreachable
      yield { type: "done", totalCost: 0 } as AgentEvent;
    } as unknown as CoordinatorDependencies["runLoop"];
    const sink = makeSink();
    const coord = new IntakeCoordinator(
      makeDeps({ sessionStore: store as any, runLoop: loop }),
      { authority: "read-only" },
    );

    await expect(coord.handle(makeMsg(), sink)).resolves.toBeUndefined();
    expect(sink.finalizeCalls).toHaveLength(0);
    expect(sink.errorCalls).toHaveLength(1);
    // A generic notice goes to the channel; the raw "model exploded" stays in
    // the log only (no internal-detail leakage to channel members).
    expect(sink.errorCalls[0].error).toContain("hit an error");
    expect(sink.errorCalls[0].error).not.toContain("model exploded");
    // Placeholder was posted before the loop, so postError gets its id.
    expect(sink.errorCalls[0].placeholderId).toBe("ph-1");
  });

  it("posts an error (not an empty finalize) when the loop yields an error event without done", async () => {
    const store = new FakeSessionStore();
    store.bind(
      {
        channelType: "slack",
        teamId: "T1",
        channelId: "C1",
        threadKey: "thread-1",
      },
      "sess-existing",
    );
    // runAgentLoop signals failure by yielding an error event and returning —
    // it does NOT throw. The coordinator must still route to postError.
    const loop = scriptedLoop([
      { type: "text-delta", delta: "partial..." },
      {
        type: "error",
        error: new Error("model API 529"),
        category: "model-api",
      },
    ]);
    const sink = makeSink();
    const coord = new IntakeCoordinator(
      makeDeps({ sessionStore: store as any, runLoop: loop }),
      { authority: "read-only" },
    );

    await expect(coord.handle(makeMsg(), sink)).resolves.toBeUndefined();
    expect(sink.finalizeCalls).toHaveLength(0);
    expect(sink.errorCalls).toHaveLength(1);
    expect(sink.errorCalls[0].placeholderId).toBe("ph-1");
    expect(sink.errorCalls[0].error).toContain("hit an error");
  });

  it("swallows a postError failure without throwing", async () => {
    const store = new FakeSessionStore();
    store.bind(
      {
        channelType: "slack",
        teamId: "T1",
        channelId: "C1",
        threadKey: "thread-1",
      },
      "sess-existing",
    );
    const loop = async function* () {
      throw new Error("boom");
    } as unknown as CoordinatorDependencies["runLoop"];
    const sink = makeSink();
    sink.postError = async () => {
      throw new Error("slack down too");
    };
    const coord = new IntakeCoordinator(
      makeDeps({ sessionStore: store as any, runLoop: loop }),
      { authority: "read-only" },
    );

    await expect(coord.handle(makeMsg(), sink)).resolves.toBeUndefined();
  });

  it("creates + binds a session on first message, resumes it on the second", async () => {
    const db = getTestDb();
    const store = new FakeSessionStore();
    const seenSessionIds: string[] = [];
    const loop = scriptedLoop(
      [{ type: "done", totalCost: 0 }],
      (_msgs, options) => seenSessionIds.push(options.sessionId),
    );
    const coord = new IntakeCoordinator(
      makeDeps({ db, sessionStore: store as any, runLoop: loop }),
      { authority: "read-only" },
    );

    await coord.handle(makeMsg(), makeSink());
    await coord.handle(makeMsg(), makeSink());

    // Bound exactly once (second message resolved the existing binding).
    expect(store.binds).toHaveLength(1);
    // Same session id used both times.
    expect(seenSessionIds).toHaveLength(2);
    expect(seenSessionIds[0]).toBe(seenSessionIds[1]);
    expect(seenSessionIds[0]).toBe(store.binds[0].id);
    db.close();
  });

  it("serializes messages in the same thread (second awaits first)", async () => {
    const store = new FakeSessionStore();
    store.bind(
      {
        channelType: "slack",
        teamId: "T1",
        channelId: "C1",
        threadKey: "thread-1",
      },
      "sess-existing",
    );
    const order: string[] = [];
    const gates: Array<() => void> = [];
    let n = 0;
    const loop = async function* () {
      const id = ++n;
      order.push(`start${id}`);
      await new Promise<void>((res) => gates.push(res));
      order.push(`end${id}`);
      yield { type: "done", totalCost: 0 } as AgentEvent;
    } as unknown as CoordinatorDependencies["runLoop"];
    const coord = new IntakeCoordinator(
      makeDeps({ sessionStore: store as any, runLoop: loop }),
      { authority: "read-only" },
    );

    const msg = makeMsg();
    const p1 = coord.handle(msg, makeSink());
    const p2 = coord.handle(msg, makeSink());

    await flush();
    // Only the first has started; the second is queued behind it.
    expect(order).toEqual(["start1"]);

    gates[0]();
    await p1;
    await flush();
    // Now the second has started.
    expect(order).toEqual(["start1", "end1", "start2"]);

    gates[1]();
    await p2;
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
  });

  it("runs messages in different threads concurrently", async () => {
    const store = new FakeSessionStore();
    for (const threadKey of ["thread-1", "thread-2"]) {
      store.bind(
        { channelType: "slack", teamId: "T1", channelId: "C1", threadKey },
        `sess-${threadKey}`,
      );
    }
    const order: string[] = [];
    const gates: Array<() => void> = [];
    let n = 0;
    const loop = async function* () {
      const id = ++n;
      order.push(`start${id}`);
      await new Promise<void>((res) => gates.push(res));
      yield { type: "done", totalCost: 0 } as AgentEvent;
    } as unknown as CoordinatorDependencies["runLoop"];
    const coord = new IntakeCoordinator(
      makeDeps({ sessionStore: store as any, runLoop: loop }),
      { authority: "read-only" },
    );

    const p1 = coord.handle(makeMsg({ threadKey: "thread-1" }), makeSink());
    const p2 = coord.handle(makeMsg({ threadKey: "thread-2" }), makeSink());

    await flush();
    // Both loops started before either was released — they ran concurrently.
    expect(order).toEqual(["start1", "start2"]);

    gates[0]();
    gates[1]();
    await Promise.all([p1, p2]);
  });
});
