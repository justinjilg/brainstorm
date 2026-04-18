/**
 * Conversation fork + handoff — protocol tier.
 *
 * The `conversations.fork` and `conversations.handoff` IPC methods
 * exist in packages/cli/src/ipc/handler.ts but have no renderer
 * consumer today. This test pins down their current contract so:
 *   1. Anyone extending the feature has a clear baseline to match.
 *   2. A silent regression in the repository layer gets trapped.
 *   3. If we ever delete these IPC methods as dead code we'll have
 *      to explicitly remove this test at the same time — forcing
 *      the deletion decision to be deliberate.
 *
 * Current contracts:
 *
 *   fork(id, name?) — create a NEW conversation that inherits the
 *     original's project, description, tags, model override, and
 *     memory overrides. Messages are NOT copied. metadata.forkedFrom
 *     points at the parent id. The SDK's fork_session preserves
 *     history through the fork point; we intentionally do not.
 *
 *   handoff(id, modelId) — update an existing conversation's
 *     modelOverride so subsequent turns route to the new model.
 *     Conversation id unchanged; no new row created.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_BIN = join(__dirname, "..", "..", "..", "node_modules", ".bin");

interface IPCHarness {
  proc: ChildProcessWithoutNullStreams;
  rl: ReadlineInterface;
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  close: () => Promise<void>;
}

let nextId = 1;

/**
 * Minimal request/response harness over the NDJSON transport.
 * Adequate for single-threaded protocol tests — every call awaits
 * its own id match before resolving.
 */
function startIPC(): IPCHarness {
  const home = mkdtempSync(join(tmpdir(), "brainstorm-convo-mut-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`,
    BRAINSTORM_HOME: home,
  };
  const proc = spawn("brainstorm", ["ipc"], {
    env,
  }) as ChildProcessWithoutNullStreams;
  const rl = createInterface({ input: proc.stdout });
  const pending = new Map<string, (value: unknown) => void>();
  let readySeen = false;
  const readyWaiters: Array<() => void> = [];

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      readySeen = true;
      for (const w of readyWaiters) w();
      readyWaiters.length = 0;
      return;
    }
    if (typeof msg.id === "string" && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)!;
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  const waitForReady = () =>
    readySeen
      ? Promise.resolve()
      : new Promise<void>((resolve) => readyWaiters.push(resolve));

  return {
    proc,
    rl,
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      await waitForReady();
      const id = `rq-${nextId++}`;
      const payload = { id, method, params: params ?? {} };
      const deferred = new Promise<unknown>((resolve, reject) => {
        pending.set(id, resolve);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method} id=${id}`));
        }, 15_000);
        timer.unref();
      });
      proc.stdin.write(JSON.stringify(payload) + "\n");
      const resp = (await deferred) as { result?: T; error?: string };
      if (resp.error) throw new Error(`ipc error on ${method}: ${resp.error}`);
      return resp.result as T;
    },
    async close() {
      proc.stdin.end();
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        setTimeout(() => {
          // `proc.killed` only tracks prior .kill() calls, not OS
          // liveness. For "is the process still alive after 3s?" use
          // exitCode/signalCode — both stay null until 'exit' fires.
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill("SIGKILL");
          }
          resolve();
        }, 3_000);
      });
    },
  };
}

interface Conversation {
  id: string;
  projectPath: string;
  name: string;
  description: string | null;
  tags: string[];
  modelOverride: string | null;
  memoryOverrides: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

describe("conversations.fork / conversations.handoff — protocol contract", () => {
  let harness: IPCHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  it("fork creates a new conversation linked to its parent, preserves settings, does NOT copy messages", async () => {
    harness = startIPC();

    const parent = await harness.request<Conversation>("conversations.create", {
      name: "parent",
      description: "original description",
      modelOverride: "anthropic/claude-opus-4-6",
    });
    expect(parent.id).toBeTruthy();

    const fork = await harness.request<Conversation>("conversations.fork", {
      id: parent.id,
      name: "fork-of-parent",
    });

    expect(fork.id, "fork must mint a fresh conversation id").not.toBe(
      parent.id,
    );
    expect(fork.name).toBe("fork-of-parent");
    expect(fork.description, "settings propagate to the fork").toBe(
      parent.description,
    );
    expect(fork.modelOverride).toBe(parent.modelOverride);
    expect(
      fork.metadata?.forkedFrom,
      "fork metadata points at the parent",
    ).toBe(parent.id);

    // Current contract: messages don't copy. If we ever change that
    // to SDK-style fork_session with history preservation, update
    // this assertion in the same commit.
    const forkMessages = await harness.request<unknown[]>(
      "conversations.messages",
      { sessionId: fork.id },
    );
    expect(
      forkMessages,
      "fork starts with empty history — change this assertion if fork semantics are extended",
    ).toHaveLength(0);
  }, 30_000);

  it("fork against a missing id returns null, not an error", async () => {
    harness = startIPC();
    const result = await harness.request<unknown>("conversations.fork", {
      id: "no-such-conversation",
    });
    expect(result).toBe(null);
  }, 30_000);

  it("handoff updates modelOverride on an existing conversation without minting a new id", async () => {
    harness = startIPC();

    const convo = await harness.request<Conversation>("conversations.create", {
      name: "handoff-target",
      modelOverride: "anthropic/claude-opus-4-6",
    });
    expect(convo.modelOverride).toBe("anthropic/claude-opus-4-6");

    const afterHandoff = await harness.request<Conversation>(
      "conversations.handoff",
      { id: convo.id, modelId: "openai/gpt-5.4" },
    );
    expect(afterHandoff.id, "handoff stays on the same conversation id").toBe(
      convo.id,
    );
    expect(afterHandoff.modelOverride).toBe("openai/gpt-5.4");

    // List must still see it — handoff shouldn't create a row clone.
    const list = await harness.request<Conversation[]>(
      "conversations.list",
      {},
    );
    const ids = list.map((c) => c.id);
    expect(
      ids.filter((x) => x === convo.id).length,
      "handoff must not duplicate the conversation row",
    ).toBe(1);
  }, 30_000);
});
