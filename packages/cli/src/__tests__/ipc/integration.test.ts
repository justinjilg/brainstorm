/**
 * IPC Integration Tests
 *
 * Spawns a real `brainstorm ipc` child process, sends NDJSON
 * requests over stdin, and verifies real responses on stdout.
 * These prove the IPC protocol works end-to-end.
 *
 * Requirements:
 * - Built CLI: `npx turbo run build --filter=@brainst0rm/cli`
 * - No API keys needed for non-chat methods
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const CLI_PATH = resolve(import.meta.dirname, "../../../dist/brainstorm.js");

/** Manages a brainstorm ipc child process for testing. */
class IPCTestClient {
  private proc: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (err: Error) => void;
    }
  >();
  /** Listeners for streaming events keyed by request id. */
  private eventListeners = new Map<string, (msg: any) => void>();
  private nextId = 1;
  private ready = false;

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("IPC backend failed to start within 15s")),
        15000,
      );

      this.proc = spawn("node", [CLI_PATH, "ipc"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Listen for "ready" on stderr
      const stderrRl = createInterface({ input: this.proc.stderr! });
      stderrRl.on("line", (line) => {
        if (line.includes("ready")) {
          this.ready = true;
          clearTimeout(timer);
          resolve();
        }
      });

      // Parse NDJSON responses from stdout
      this.rl = createInterface({ input: this.proc.stdout! });
      this.rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.id && msg.event && this.eventListeners.has(msg.id)) {
            // Streaming event — forward to collector
            this.eventListeners.get(msg.id)!(msg);
          } else if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            res(msg);
          }
        } catch {
          // Non-JSON line — should not happen with pino→stderr fix
          console.error("Non-JSON on stdout:", line);
        }
      });

      this.proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      this.proc.on("exit", (code) => {
        if (!this.ready) {
          clearTimeout(timer);
          reject(new Error(`IPC exited with code ${code} before ready`));
        }
      });
    });
  }

  /** Send a request and wait for the response. */
  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<any> {
    if (!this.proc?.stdin?.writable) {
      throw new Error("IPC process not running");
    }

    const id = `test-${this.nextId++}`;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after 10s`));
      }, 10000);

      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /**
   * Send a request that produces streaming events.
   * Collects events until a terminal event (stream-end, daemon-stopped,
   * workflow-end) or timeout. Also resolves the initial {id, result} if sent.
   */
  async requestStream(
    method: string,
    params: Record<string, unknown> = {},
    opts: { terminalEvent?: string; timeout?: number } = {},
  ): Promise<{ result?: any; error?: string; events: any[] }> {
    if (!this.proc?.stdin?.writable) {
      throw new Error("IPC process not running");
    }

    const id = `test-${this.nextId++}`;
    const terminal = opts.terminalEvent ?? "stream-end";
    const timeout = opts.timeout ?? 15000;
    const events: any[] = [];
    let initialResult: any = undefined;
    let initialError: string | undefined = undefined;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventListeners.delete(id);
        this.pending.delete(id);
        // Resolve with whatever we collected so far
        resolve({ result: initialResult, error: initialError, events });
      }, timeout);

      // Collect streaming events
      this.eventListeners.set(id, (msg) => {
        events.push(msg);
        if (
          msg.event === terminal ||
          msg.event === "error" ||
          msg.event === "daemon-error"
        ) {
          clearTimeout(timer);
          this.eventListeners.delete(id);
          this.pending.delete(id);
          resolve({ result: initialResult, error: initialError, events });
        }
      });

      // Also capture the initial result/error response
      this.pending.set(id, {
        resolve: (msg) => {
          if (msg.result) initialResult = msg.result;
          if (msg.error) {
            initialError = msg.error;
            clearTimeout(timer);
            this.eventListeners.delete(id);
            resolve({ result: initialResult, error: initialError, events });
          }
          // Don't resolve yet — wait for streaming events
        },
        reject: (err) => {
          clearTimeout(timer);
          this.eventListeners.delete(id);
          reject(err);
        },
      });

      this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.stdin?.end();
      // Give it a moment to exit cleanly
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.proc?.kill("SIGTERM");
          resolve();
        }, 3000);
        this.proc!.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.proc = null;
    }
  }
}

describe("IPC Integration — real brainstorm ipc backend", () => {
  const client = new IPCTestClient();

  beforeAll(async () => {
    await client.start();
  }, 20000);

  afterAll(async () => {
    await client.stop();
  });

  // ── Health ─────────────────────────────────────────────────────

  it("health returns status and version", async () => {
    const res = await client.request("health");
    expect(res.result).toBeDefined();
    expect(res.result.status).toBe("healthy");
    expect(res.result.version).toBeDefined();
    expect(res.result.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  // ── Tools ──────────────────────────────────────────────────────

  it("tools.list returns non-empty array of tools", async () => {
    const res = await client.request("tools.list");
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result)).toBe(true);
    expect(res.result.length).toBeGreaterThan(10);
    // Each tool should have name, description, permission
    const first = res.result[0];
    expect(first.name).toBeDefined();
    expect(typeof first.name).toBe("string");
    expect(first.permission).toBeDefined();
  });

  // ── Models ─────────────────────────────────────────────────────

  it("models.list returns array with provider info", async () => {
    const res = await client.request("models.list");
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result)).toBe(true);
    // Even with no API keys, should have some models from discovery
    if (res.result.length > 0) {
      const model = res.result[0];
      expect(model.id).toBeDefined();
      expect(model.name).toBeDefined();
      expect(model.provider).toBeDefined();
    }
  });

  // ── Skills ─────────────────────────────────────────────────────

  it("skills.list returns builtin skills", async () => {
    const res = await client.request("skills.list");
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result)).toBe(true);
    // Should have at least the 20 builtin skills
    expect(res.result.length).toBeGreaterThanOrEqual(20);
    const names = res.result.map((s: any) => s.name);
    expect(names).toContain("code-review-and-quality");
    expect(names).toContain("test-driven-development");
  });

  // ── Memory ─────────────────────────────────────────────────────

  it("memory.list returns array", async () => {
    const res = await client.request("memory.list");
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result)).toBe(true);
  });

  // ── Config ─────────────────────────────────────────────────────

  it("config.get returns config without secrets", async () => {
    const res = await client.request("config.get");
    expect(res.result).toBeDefined();
    expect(res.result.general).toBeDefined();
    // Providers is an object keyed by name — all secret fields stripped
    const providers = res.result.providers;
    if (providers && typeof providers === "object") {
      for (const [, providerCfg] of Object.entries(providers)) {
        const cfg = providerCfg as Record<string, unknown>;
        expect(cfg.apiKey).toBeUndefined();
        expect(cfg.apiKeyName).toBeUndefined();
        expect(cfg.secret).toBeUndefined();
        expect(cfg.token).toBeUndefined();
      }
    }
  });

  // ── Conversations ──────────────────────────────────────────────

  it("conversations.list returns array", async () => {
    const res = await client.request("conversations.list");
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result)).toBe(true);
  });

  // ── KAIROS ─────────────────────────────────────────────────────

  it("kairos.status returns stopped when not running", async () => {
    const res = await client.request("kairos.status");
    expect(res.result).toBeDefined();
    expect(res.result.status).toBe("stopped");
  });

  // ── Workflow presets ───────────────────────────────────────────

  it("workflow.presets returns preset workflows", async () => {
    const res = await client.request("workflow.presets");
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result)).toBe(true);
    if (res.result.length > 0) {
      expect(res.result[0].id).toBeDefined();
      expect(res.result[0].name).toBeDefined();
    }
  });

  // ── Validation ─────────────────────────────────────────────────

  it("rejects unknown method", async () => {
    const res = await client.request("shell.exec", { command: "ls" });
    expect(res.error).toBeDefined();
    expect(res.error).toContain("Unknown method");
  });

  it("rejects invalid params with Zod error", async () => {
    const res = await client.request("memory.create", {
      // Missing required 'name' and 'content'
    });
    expect(res.error).toBeDefined();
    expect(res.error).toContain("Validation error");
  });

  it("rejects wrong type with Zod error", async () => {
    const res = await client.request("memory.delete", {
      id: 42, // Should be string
    });
    expect(res.error).toBeDefined();
    expect(res.error).toContain("Validation error");
  });

  // ── Multiple requests ──────────────────────────────────────────

  it("handles rapid sequential requests", async () => {
    const results = await Promise.all([
      client.request("health"),
      client.request("tools.list"),
      client.request("models.list"),
      client.request("kairos.status"),
    ]);
    expect(results).toHaveLength(4);
    expect(results[0].result.status).toBe("healthy");
    expect(Array.isArray(results[1].result)).toBe(true);
    expect(Array.isArray(results[2].result)).toBe(true);
    expect(results[3].result.status).toBe("stopped");
  });

  // ── Conversations CRUD ─────────────────────────────────────────

  it("conversations.create creates and returns a conversation", async () => {
    const res = await client.request("conversations.create", {
      name: "Test Conversation",
      description: "Integration test",
    });
    expect(res.result).toBeDefined();
    expect(res.result.id).toBeDefined();
    expect(res.result.name).toBe("Test Conversation");
  });

  it("conversations.create + fork produces a new conversation", async () => {
    // Create original
    const created = await client.request("conversations.create", {
      name: "Original Conv",
    });
    expect(created.result.id).toBeDefined();

    // Fork it
    const forked = await client.request("conversations.fork", {
      id: created.result.id,
      name: "Forked Conv",
    });
    expect(forked.result).toBeDefined();
    expect(forked.result.id).not.toBe(created.result.id);
    expect(forked.result.name).toBe("Forked Conv");
  });

  it("conversations.handoff updates model override", async () => {
    const created = await client.request("conversations.create", {
      name: "Handoff Test",
    });
    const handoff = await client.request("conversations.handoff", {
      id: created.result.id,
      modelId: "claude-opus-4-6",
    });
    expect(handoff.result).toBeDefined();
    expect(handoff.result.modelOverride).toBe("claude-opus-4-6");
  });

  it("conversations.messages returns messages for a session", async () => {
    // Use a random session ID — should return empty array, not error
    const res = await client.request("conversations.messages", {
      sessionId: "nonexistent-session-id",
    });
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result)).toBe(true);
    expect(res.result).toHaveLength(0);
  });

  // ── Security Red Team ──────────────────────────────────────────

  it("security.redteam runs simulation and returns scorecard", async () => {
    const res = await client.request("security.redteam", {
      generations: 2,
      populationSize: 10,
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
    // Scorecard should have some structure
    expect(typeof res.result).toBe("object");
  });

  // ── KAIROS lifecycle ───────────────────────────────────────────

  it("kairos.stop returns not-running when daemon is stopped", async () => {
    const res = await client.request("kairos.stop");
    expect(res.result).toBeDefined();
    expect(res.result.ok).toBe(false);
    expect(res.result.reason).toBe("Not running");
  });

  it("kairos.pause returns not-running when daemon is stopped", async () => {
    const res = await client.request("kairos.pause");
    expect(res.result).toBeDefined();
    expect(res.result.ok).toBe(false);
    expect(res.result.reason).toBe("Not running");
  });

  it("kairos.resume returns not-running when daemon is stopped", async () => {
    const res = await client.request("kairos.resume");
    expect(res.result).toBeDefined();
    expect(res.result.ok).toBe(false);
    expect(res.result.reason).toBe("Not running");
  });

  // ── Chat abort ─────────────────────────────────────────────────

  it("chat.abort returns no-active-stream when nothing is streaming", async () => {
    const res = await client.request("chat.abort");
    expect(res.result).toBeDefined();
    expect(res.result.ok).toBe(false);
    expect(res.result.reason).toBe("No active stream");
  });

  // ── Workflow run ───────────────────────────────────────────────

  it("workflow.run rejects unknown workflow ID", async () => {
    const res = await client.requestStream(
      "workflow.run",
      {
        workflowId: "nonexistent-workflow",
        request: "test",
      },
      { terminalEvent: "workflow-end", timeout: 5000 },
    );
    // Should get an error, not crash
    expect(res.error).toBeDefined();
    expect(res.error).toContain("Unknown workflow");
  });
});
