/**
 * NDJSON framing torture — spawns a real `brainstorm ipc` child and
 * exercises the wire protocol with adversarial stdin across boundary
 * conditions the renderer would never emit but a bug in any transport
 * middleman could.
 *
 * Pattern lifted from anthropics/claude-agent-sdk-python's
 * `test_subprocess_buffering.py`: treat the subprocess transport as
 * a first-class testable unit. The unit-level `parseBackendLine`
 * tests in ipc-protocol.test.ts cover the parser. This file covers
 * the actual subprocess pipeline — stdin closing, stdout framing,
 * readline boundary handling, and graceful exit.
 *
 * Each test owns its own `brainstorm ipc` process. Fresh BRAINSTORM_HOME
 * per test so nothing collides on the user's real DB.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_BIN = join(__dirname, "..", "..", "..", "node_modules", ".bin");

interface IPCHarness {
  proc: ChildProcessWithoutNullStreams;
  rl: ReadlineInterface;
  stdoutLines: string[];
  waitForLine: (
    predicate: (line: string) => boolean,
    timeoutMs?: number,
  ) => Promise<string>;
  send: (obj: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

/**
 * Spawn the workspace brainstorm ipc CLI, wire up a readline-driven
 * harness, and return handles for sending requests + waiting for
 * specific responses. Keeps the test body focused on the protocol
 * contract rather than process plumbing.
 */
function startIPC(): IPCHarness {
  const home = mkdtempSync(join(tmpdir(), "brainstorm-ndjson-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${WORKSPACE_BIN}:${process.env.PATH ?? ""}`,
    BRAINSTORM_HOME: home,
  };
  const proc = spawn("brainstorm", ["ipc"], {
    env,
  }) as ChildProcessWithoutNullStreams;
  const rl = createInterface({ input: proc.stdout });
  const stdoutLines: string[] = [];
  const listeners = new Set<(line: string) => void>();
  rl.on("line", (line) => {
    stdoutLines.push(line);
    for (const l of listeners) l(line);
  });

  return {
    proc,
    rl,
    stdoutLines,
    async waitForLine(predicate, timeoutMs = 15_000) {
      // Fast path: already buffered.
      const existing = stdoutLines.find(predicate);
      if (existing) return existing;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(
            new Error(
              `waitForLine timed out after ${timeoutMs}ms. Captured ${stdoutLines.length} line(s): ${stdoutLines.slice(-5).join(" | ")}`,
            ),
          );
        }, timeoutMs);
        const listener = (line: string) => {
          if (predicate(line)) {
            clearTimeout(timer);
            listeners.delete(listener);
            resolve(line);
          }
        };
        listeners.add(listener);
      });
    },
    send(obj) {
      proc.stdin.write(JSON.stringify(obj) + "\n");
    },
    async close() {
      proc.stdin.end();
      return new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
          resolve();
        }, 3_000);
      });
    },
  };
}

describe("NDJSON framing — real brainstorm ipc subprocess", () => {
  let harness: IPCHarness | null = null;

  beforeEach(() => {
    harness = null;
  });
  afterEach(async () => {
    if (harness) await harness.close();
  });

  it('emits a {type:"ready"} line on startup', async () => {
    harness = startIPC();
    const line = await harness.waitForLine((l) => l.includes('"type":"ready"'));
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("ready");
    // Every readiness message must carry a version so the renderer can
    // tell old backends apart after an upgrade.
    expect(typeof parsed.version).toBe("string");
  }, 30_000);

  it("responds to a well-formed tools.list request in one NDJSON frame", async () => {
    harness = startIPC();
    await harness.waitForLine((l) => l.includes('"type":"ready"'));
    harness.send({ id: "rq-1", method: "tools.list", params: {} });
    const line = await harness.waitForLine((l) => l.includes('"id":"rq-1"'));
    const parsed = JSON.parse(line);
    expect(parsed.id).toBe("rq-1");
    expect(Array.isArray(parsed.result)).toBe(true);
    // Every frame must be a complete JSON object on a single line —
    // if the backend ever writes a raw object without terminating
    // newline this test's next waitForLine would time out.
    expect(line.includes("\n")).toBe(false);
  }, 30_000);

  it("tolerates a malformed JSON line between valid requests (line is ignored, NOT crash)", async () => {
    harness = startIPC();
    await harness.waitForLine((l) => l.includes('"type":"ready"'));

    // Malformed: open brace, no close, broken quotes. If the backend's
    // line handler used `JSON.parse(line)` without a try/catch this
    // would take the whole process down.
    harness.proc.stdin.write("{ this is not json }\n");

    // Empty line. Must be ignored.
    harness.proc.stdin.write("\n");

    // A JSON array (valid JSON but not an object). Backend should
    // silently skip — we don't accept arrays at the top level.
    harness.proc.stdin.write("[1,2,3]\n");

    // Now a well-formed request — must still go through.
    harness.send({ id: "rq-after-garbage", method: "tools.list", params: {} });
    const line = await harness.waitForLine((l) =>
      l.includes('"id":"rq-after-garbage"'),
    );
    const parsed = JSON.parse(line);
    expect(parsed.id).toBe("rq-after-garbage");
    expect(Array.isArray(parsed.result)).toBe(true);
  }, 30_000);

  it("handles back-to-back requests on a single line separated only by newlines", async () => {
    harness = startIPC();
    await harness.waitForLine((l) => l.includes('"type":"ready"'));

    // Two requests written as a single chunk. readline's line-buffer
    // must split on \n and dispatch both. If the handler ever reads
    // the whole chunk as one JSON.parse this fails because the parser
    // sees two concatenated objects.
    const payload =
      JSON.stringify({ id: "rq-a", method: "tools.list", params: {} }) +
      "\n" +
      JSON.stringify({ id: "rq-b", method: "health", params: {} }) +
      "\n";
    harness.proc.stdin.write(payload);

    const lineA = await harness.waitForLine((l) => l.includes('"id":"rq-a"'));
    const lineB = await harness.waitForLine((l) => l.includes('"id":"rq-b"'));
    expect(JSON.parse(lineA).id).toBe("rq-a");
    expect(JSON.parse(lineB).id).toBe("rq-b");
  }, 30_000);

  it("handles a request chunked across multiple stdin writes", async () => {
    harness = startIPC();
    await harness.waitForLine((l) => l.includes('"type":"ready"'));

    // Slice a valid request into 3 partial writes with no newline
    // until the last chunk. readline must buffer and emit exactly
    // once on the trailing \n.
    const full = JSON.stringify({
      id: "rq-chunked",
      method: "tools.list",
      params: {},
    });
    const a = full.slice(0, 10);
    const b = full.slice(10, 30);
    const c = full.slice(30) + "\n";
    harness.proc.stdin.write(a);
    await new Promise((r) => setTimeout(r, 50));
    harness.proc.stdin.write(b);
    await new Promise((r) => setTimeout(r, 50));
    harness.proc.stdin.write(c);

    const line = await harness.waitForLine((l) =>
      l.includes('"id":"rq-chunked"'),
    );
    expect(JSON.parse(line).id).toBe("rq-chunked");
  }, 30_000);

  it("exits cleanly when stdin closes", async () => {
    harness = startIPC();
    await harness.waitForLine((l) => l.includes('"type":"ready"'));
    const proc = harness.proc;
    proc.stdin.end();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              "brainstorm ipc did not exit within 5s of stdin closing — there is a lingering handle or active handler",
            ),
          ),
        5_000,
      );
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    harness = null; // prevent afterEach from double-closing
  }, 15_000);
});
