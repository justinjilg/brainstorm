/**
 * IPC Handler — NDJSON stdio protocol for the desktop app.
 *
 * Reads JSON requests from stdin, dispatches to existing packages,
 * writes NDJSON responses to stdout. No HTTP, no ports.
 *
 * Protocol:
 *   → stdin:  {"id":"1","method":"tools.list","params":{}}
 *   ← stdout: {"id":"1","result":[...]}
 *
 * For streaming (chat):
 *   → stdin:  {"id":"1","method":"chat.stream","params":{"message":"hello"}}
 *   ← stdout: {"id":"1","event":"text-delta","data":{"delta":"Hello "}}
 *   ← stdout: {"id":"1","event":"done","data":{"cost":0.0042}}
 */

import { createInterface } from "node:readline";
import { z } from "zod";
import type { Database } from "better-sqlite3";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { BrainstormRouter } from "@brainst0rm/router";
import { collectOpenDrifts } from "../perception/drift.js";
import { enterWorkspace } from "@brainst0rm/tools";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createDaemonRegistry } from "../daemon/self-heal-tools.js";

/**
 * Ensure the self-improvement daemon has its OWN full git CLONE (its own .git,
 * refs, stash, HEAD) so NO git operation it performs — even a stray one — can
 * reach the user's repository. A shared-.git worktree was tried and failed
 * three times: AsyncLocalStorage workspace scoping does not reliably reach the
 * shell tool, so raw `git stash`/`reset` escaped to main. A separate clone
 * removes that entire class of failure at the filesystem level.
 *
 * `--local` hardlinks immutable objects (fast, disk-light) but the clone's
 * refs/stash/index/HEAD are entirely its own. Returns the absolute clone path,
 * or null if isolation could not be established (caller then declines write
 * autonomy). Deps for the clone's verify step are installed out-of-band
 * (`pnpm install` inside the clone — isolated, never symlinked).
 */
function ensureSelfHealClone(
  repoPath: string,
  cloneSetting: string,
  branch: string,
): string | null {
  if (!cloneSetting) return null;
  const expanded = cloneSetting.startsWith("~")
    ? join(homedir(), cloneSetting.slice(1))
    : cloneSetting;
  const clonePath = resolve(repoPath, expanded);
  const gitIn = (dir: string, args: string[], timeout = 20000): string =>
    execFileSync("git", ["-C", dir, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    }).toString();
  try {
    // Reuse an existing clone only if it is a real, independent repository
    // (its .git is a DIRECTORY — a worktree's .git is a file pointer at main)
    // AND it is on the self-heal branch. Anything else → fail closed.
    if (existsSync(join(clonePath, ".git"))) {
      const gitIsDir = (() => {
        try {
          return statSync(join(clonePath, ".git")).isDirectory();
        } catch {
          return false;
        }
      })();
      if (!gitIsDir) {
        process.stderr.write(
          `[ipc] ${clonePath} exists but is not an independent clone (shared .git) — refusing; remove it to let a real clone be created\n`,
        );
        return null;
      }
      const head = gitIn(clonePath, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]).trim();
      if (head === branch) return clonePath;
      process.stderr.write(
        `[ipc] self-heal clone at ${clonePath} is on "${head}", not "${branch}" — refusing to reuse (autonomy stays propose)\n`,
      );
      return null;
    }
    if (existsSync(clonePath)) {
      process.stderr.write(
        `[ipc] ${clonePath} exists but has no .git — refusing to clone over it\n`,
      );
      return null;
    }
    // Create the independent clone from the local repo's committed state, then
    // put it on the self-heal branch. 3-minute bound so a hung clone can't
    // wedge daemon start.
    execFileSync("git", ["clone", "--local", repoPath, clonePath], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 180000,
    });
    gitIn(clonePath, ["checkout", "-B", branch]);
    return clonePath;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[ipc] self-heal clone could not be established at ${clonePath}: ${raw.split("\n")[0]}\n`,
    );
    return null;
  }
}

// ── IPC Param Schemas ─────────────────────────────────────────────
// Every method with params gets a Zod schema. Methods with no params
// (tools.list, memory.list, etc.) use z.object({}).

const MemoryCreateParams = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  type: z.enum(["user", "feedback", "project", "reference"]).optional(),
  source: z.string().optional(),
});

const MemoryUpdateParams = z.object({
  id: z.string().min(1),
  tier: z.enum(["system", "archive", "quarantine"]).optional(),
  content: z.string().optional(),
});

const MemoryDeleteParams = z.object({
  id: z.string().min(1),
});

const ConversationsListParams = z.object({
  project: z.string().optional(),
});

const ConversationsCreateParams = z.object({
  projectPath: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  modelOverride: z.string().optional(),
});

const ConversationsForkParams = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
});

const ConversationsHandoffParams = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
});

const ConversationsMessagesParams = z.object({
  sessionId: z.string().min(1),
});

const ChatStreamParams = z.object({
  message: z.string().min(1),
  // conversationId and sessionId are aliases from the renderer's perspective —
  // the desktop app calls this "conversationId" (one per sidebar entry), the
  // backend calls it "sessionId" (the agent-loop session key). Either is
  // accepted; conversationId wins if both are sent. Pre-fix the renderer
  // sent conversationId and Zod stripped it (.strip()), so every turn
  // opened a brand-new session and the sidebar "same conversation" was
  // an illusion.
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  modelId: z.string().optional(),
  role: z.string().optional(),
  activeSkills: z.array(z.string()).optional(),
});

const SecurityRedteamParams = z.object({
  generations: z.number().int().positive().optional(),
  populationSize: z.number().int().positive().optional(),
});

const WorkflowRunParams = z.object({
  workflowId: z.string().min(1),
  request: z.string().min(1),
});

export interface IPCContext {
  db: Database;
  config: BrainstormConfig;
  registry: any; // ProviderRegistry (object with .models array)
  router: BrainstormRouter;
  tools: any; // ToolRegistry (class with .getAll())
  memoryManager: any;
  version: string;
  projectPath: string;
}

interface IPCRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Write a single NDJSON line to stdout. */
function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/** Send a result response for a request. */
function sendResult(id: string, result: unknown): void {
  send({ id, result });
}

/** Send an error response for a request. */
function sendError(id: string, error: string): void {
  send({ id, error });
}

/** Send a streaming event for a request. */
function sendEvent(id: string, event: string, data: unknown): void {
  send({ id, event, data });
}

/**
 * Return renderer-safe provider configuration. Header names are useful for UI
 * diagnostics, but their values are credentials just as often as apiKey fields.
 */
export function sanitizeProvidersForIPC(
  providers: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> {
  const safeProviders: Record<string, Record<string, unknown>> = {};
  for (const [name, providerCfg] of Object.entries(providers ?? {})) {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      providerCfg as Record<string, unknown>,
    )) {
      if (/key|secret|token/i.test(key)) continue;
      if (key.toLowerCase() === "headers") {
        const headerNames =
          value && typeof value === "object" ? Object.keys(value) : [];
        safe.headers = Object.fromEntries(
          headerNames.map((headerName) => [headerName, "[configured]"]),
        );
        continue;
      }
      safe[key] = value;
    }
    safe.name = name;
    safeProviders[name] = safe;
  }
  return safeProviders;
}

/**
 * Pick a diverse council of 2–3 available models across distinct providers, for
 * an exchange whose caller didn't name participants. Diversity is the point of a
 * council, so we prefer one model per provider before doubling up.
 */
function pickCouncil(
  models: Array<{ id: string; provider?: string; status?: string }>,
): Array<{ model: string; provider?: string }> {
  const avail = models.filter(
    (m) => (m.status ?? "available") !== "unavailable",
  );
  const byProvider = new Map<string, { id: string; provider?: string }>();
  for (const m of avail) {
    const prov = m.provider ?? "unknown";
    if (!byProvider.has(prov)) byProvider.set(prov, m);
  }
  const diverse = [...byProvider.values()].slice(0, 3);
  const chosen = diverse.length >= 2 ? diverse : avail.slice(0, 3);
  return chosen.map((m) => ({ model: m.id, provider: m.provider }));
}

export async function startIPCHandler(ctx: IPCContext): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let abortController: AbortController | null = null;
  let daemonController: any = null; // DaemonController instance
  let organismUnsub: (() => void) | null = null; // organism.subscribe teardown
  let exchangeAbort: AbortController | null = null; // active exchange abort
  let pendingDispatches = 0;
  let stdinClosed = false;

  // Pre-import core modules to avoid dynamic import deadlocks inside handlers
  const coreModule = await import("@brainst0rm/core");
  const dbModule = await import("@brainst0rm/db");
  const routerModule = await import("@brainst0rm/router");

  /**
   * Convene an exchange (models talking to models). Streams its `exchange.*`
   * events onto the organism bus — so Council/Pulse light up live — and, when a
   * `streamReqId` is given, also to that request. Reused by the `exchange.start`
   * IPC method and by KAIROS when it deliberates before a high-stakes self-heal.
   */
  const conveneExchange = (
    prompt: string,
    opts: {
      participants?: Array<{ model: string; provider?: string }>;
      reconciler?: "vote" | "judge" | "owner";
      budgetCap?: number;
      streamReqId?: string;
    } = {},
  ):
    | { ok: true; exchangeId: string; participants: string[] }
    | { ok: false; error: string } => {
    const { ExchangeController, recordExchangeStart, recordExchangeEnd } =
      coreModule;
    const participants =
      opts.participants && opts.participants.length >= 2
        ? opts.participants
        : pickCouncil(ctx.registry.models ?? []);
    if (participants.length < 2) {
      return {
        ok: false,
        error: "Need at least 2 available models to convene a council.",
      };
    }
    const generate = async (args: {
      model: string;
      system: string;
      prompt: string;
      signal?: AbortSignal;
    }): Promise<{ text: string; cost?: number }> => {
      const lm = ctx.registry.getProvider(args.model);
      if (!lm) throw new Error(`No provider available for model ${args.model}`);
      const { generateText } = await import("ai");
      const res = await generateText({
        model: lm,
        system: args.system,
        prompt: args.prompt,
        abortSignal: args.signal,
      });
      return { text: res.text ?? "", cost: 0 };
    };
    exchangeAbort = new AbortController();
    const ctrl = new ExchangeController(
      {
        prompt,
        participants,
        reconciler: opts.reconciler ?? "vote",
        budgetCap: opts.budgetCap,
      },
      generate,
      { signal: exchangeAbort.signal },
    );
    recordExchangeStart({
      exchangeId: ctrl.exchangeId,
      prompt,
      participants: participants.map((x) => x.model),
    });
    void (async () => {
      try {
        for await (const ev of ctrl.run()) {
          if (opts.streamReqId) sendEvent(opts.streamReqId, ev.type, ev);
          if (ev.type === "exchange.reconciled") {
            recordExchangeEnd(ctrl.exchangeId, {
              status: "reconciled",
              resolution: ev.resolution,
              method: ev.method,
            });
          } else if (ev.type === "exchange.aborted") {
            recordExchangeEnd(ctrl.exchangeId, { status: "aborted" });
          }
        }
      } catch (err) {
        if (opts.streamReqId) {
          sendEvent(opts.streamReqId, "exchange-error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        recordExchangeEnd(ctrl.exchangeId, { status: "aborted" });
      } finally {
        exchangeAbort = null;
      }
    })();
    return {
      ok: true,
      exchangeId: ctrl.exchangeId,
      participants: participants.map((x) => x.model),
    };
  };

  // Log to stderr so it doesn't pollute the NDJSON stdout channel
  const log = (msg: string) => process.stderr.write(`[ipc] ${msg}\n`);

  // Catch unhandled errors so they don't silently kill the process
  process.on("uncaughtException", (err) => {
    log(`Uncaught exception: ${err.message}`);
    log(err.stack ?? "");
    // Send error to renderer
    send({ event: "error", error: `IPC uncaught: ${err.message}` });
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log(`Unhandled rejection: ${msg}`);
    send({ event: "error", error: `IPC unhandled: ${msg}` });
  });

  log(`Brainstorm IPC v${ctx.version} ready`);
  // Structured readiness signal on the NDJSON channel so the desktop app
  // doesn't have to pattern-match the stderr log line. Main consumes this
  // and flips backendReady exactly once.
  process.stdout.write(
    JSON.stringify({ type: "ready", version: ctx.version }) + "\n",
  );

  function maybeExit(): void {
    if (stdinClosed && pendingDispatches === 0) {
      log("stdin closed and all dispatches complete, exiting");
      process.exit(0);
    }
  }

  rl.on("line", async (line: string) => {
    let req: IPCRequest;
    try {
      req = JSON.parse(line);
    } catch {
      send({ error: "Invalid JSON" });
      return;
    }

    if (!req.id || !req.method) {
      send({ error: "Missing id or method" });
      return;
    }

    pendingDispatches++;
    try {
      await dispatch(req, ctx);
    } catch (err) {
      let msg: string;
      if (err instanceof z.ZodError) {
        // Format Zod validation errors clearly
        const issues = err.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        msg = `Validation error: ${issues}`;
      } else {
        msg = err instanceof Error ? err.message : String(err);
      }
      sendError(req.id, msg);
      log(`Error handling ${req.method}: ${msg}`);
    } finally {
      pendingDispatches--;
      maybeExit();
    }
  });

  rl.on("close", () => {
    stdinClosed = true;
    if (organismUnsub) {
      organismUnsub();
      organismUnsub = null;
    }
    log("stdin closed, waiting for pending dispatches...");
    maybeExit();
  });

  async function dispatch(req: IPCRequest, ctx: IPCContext): Promise<void> {
    const params = req.params ?? {};

    switch (req.method) {
      // ── Tools ────────────────────────────────────────────────
      case "tools.list": {
        const tools = ctx.tools.getAll().map((t: any) => ({
          name: t.name,
          description: t.description,
          permission: t.permission ?? "auto",
        }));
        sendResult(req.id, tools);
        break;
      }

      // ── Memory ───────────────────────────────────────────────
      case "memory.list": {
        const entries = ctx.memoryManager.list();
        sendResult(req.id, entries);
        break;
      }

      case "memory.create": {
        const { name, content, type, source } =
          MemoryCreateParams.parse(params);
        await ctx.memoryManager.save({
          name,
          content,
          type: type ?? "project",
          source: source ?? "user",
        });
        sendResult(req.id, { ok: true });
        break;
      }

      case "memory.update": {
        const {
          id,
          tier,
          content: memContent,
        } = MemoryUpdateParams.parse(params);
        if (tier === "system") {
          await ctx.memoryManager.promote(id);
        } else if (tier === "archive") {
          await ctx.memoryManager.demote(id);
        } else if (tier === "quarantine") {
          await ctx.memoryManager.quarantine?.(id);
        }
        if (memContent) {
          await ctx.memoryManager.updateContent?.(id, memContent);
        }
        sendResult(req.id, { ok: true });
        break;
      }

      case "memory.delete": {
        const { id: memId } = MemoryDeleteParams.parse(params);
        await ctx.memoryManager.delete(memId);
        sendResult(req.id, { ok: true });
        break;
      }

      // ── Skills ───────────────────────────────────────────────
      case "skills.list": {
        // loadSkills is synchronous — reads skill files from disk
        let skills: any[] = [];
        try {
          const core = coreModule;
          skills = core.loadSkills(ctx.projectPath);
        } catch (e) {
          log(
            `skills.list error: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        sendResult(
          req.id,
          skills.map((s: any) => ({
            name: s.name,
            description: s.description ?? "",
            source: s.source ?? "builtin",
            content: s.content ?? "",
          })),
        );
        break;
      }

      // ── Models ───────────────────────────────────────────────
      case "models.list": {
        const models = (ctx.registry.models ?? []).map((m: any) => ({
          id: m.id,
          name: m.name ?? m.id,
          provider: m.provider,
          status: m.status ?? "available",
          pricing: m.pricing ?? {
            inputPer1MTokens: 0,
            outputPer1MTokens: 0,
          },
          capabilities: m.capabilities ?? {},
        }));
        sendResult(req.id, models);
        break;
      }

      // ── Conversations ────────────────────────────────────────
      case "conversations.list": {
        const { project } = ConversationsListParams.parse(params);
        const { ConversationRepository } = dbModule;
        const repo = new ConversationRepository(ctx.db);
        const convs = repo.list(project);
        sendResult(req.id, convs);
        break;
      }

      case "conversations.create": {
        const { projectPath, name, description, modelOverride } =
          ConversationsCreateParams.parse(params);
        const { ConversationRepository } = dbModule;
        const repo = new ConversationRepository(ctx.db);
        const conv = repo.create(projectPath ?? ctx.projectPath, {
          name: name ?? "Untitled",
          description,
          modelOverride,
        });
        sendResult(req.id, conv);
        break;
      }

      case "conversations.fork": {
        const { id: forkId, name: forkName } =
          ConversationsForkParams.parse(params);
        const { ConversationRepository } = dbModule;
        const repo = new ConversationRepository(ctx.db);
        const conv = repo.fork(forkId, forkName);
        sendResult(req.id, conv);
        break;
      }

      case "conversations.handoff": {
        const { id: handoffId, modelId: handoffModel } =
          ConversationsHandoffParams.parse(params);
        const { ConversationRepository } = dbModule;
        const repo = new ConversationRepository(ctx.db);
        const conv = repo.update(handoffId, {
          modelOverride: handoffModel,
        });
        sendResult(req.id, conv);
        break;
      }

      case "conversations.messages": {
        const { sessionId: msgSessionId } =
          ConversationsMessagesParams.parse(params);
        const { MessageRepository } = dbModule;
        const repo = new MessageRepository(ctx.db);
        const messages = repo.listBySession(msgSessionId);
        sendResult(req.id, messages);
        break;
      }

      // ── Config ───────────────────────────────────────────────
      case "config.get": {
        const { loadConfig: loadCfg } =
          await import("@brainst0rm/config"); /* config only used once */
        const config = loadCfg();
        // Scrub secrets — providers is an object keyed by name (gateway, ollama, etc.)
        // Strip any fields containing key/secret/token values
        const safeProviders = sanitizeProvidersForIPC(config.providers);
        sendResult(req.id, {
          general: config.general,
          budget: config.budget,
          daemon: config.daemon,
          providers: safeProviders,
        });
        break;
      }

      // ── KAIROS Daemon ────────────────────────────────────────
      case "kairos.start": {
        if (daemonController) {
          sendError(req.id, "Daemon already running");
          break;
        }
        // Hard gate: the daemon must be explicitly enabled in config. This is
        // the authoritative kill switch — the desktop auto-starts KAIROS on
        // launch, so `daemon.enabled = false` MUST be honored here or the
        // config toggle is meaningless. Disabled after repeated isolation
        // escapes; do not remove without a bulletproof isolation model.
        if (!ctx.config.daemon.enabled) {
          sendError(req.id, "Daemon is disabled (daemon.enabled = false)");
          break;
        }

        const {
          DaemonController,
          buildSystemPrompt: buildSP,
          loadSkills: loadSk,
          runAgentLoop: runLoop,
        } = coreModule;
        const { CostTracker: CT } = routerModule;
        const { prompt: fp } = buildSP(ctx.projectPath);
        const skills = loadSk(ctx.projectPath);
        const costTracker = new CT(ctx.db, ctx.config.budget);

        // ── Awakening senses for the desktop daemon ──
        const { PlatformEventRepository: KairosEvents } = dbModule;
        const kairosEventStore = new KairosEvents(ctx.db);
        const { createGatewayClient: createKairosGw } =
          await import("@brainst0rm/gateway");
        const kairosGw = createKairosGw();
        let kairosBrStatus: {
          connected: boolean;
          models?: number;
          note?: string;
        } = kairosGw
          ? { connected: true }
          : { connected: false, note: "BRAINSTORM_API_KEY not set" };
        if (kairosGw) {
          void kairosGw
            .listModels()
            .then((models: unknown) => {
              const count = Array.isArray(models)
                ? models.length
                : ((models as { data?: unknown[] })?.data?.length ?? undefined);
              kairosBrStatus = { connected: true, models: count };
            })
            .catch((err: unknown) => {
              kairosBrStatus = {
                connected: false,
                note: `BR unreachable: ${err instanceof Error ? err.message : String(err)}`,
              };
            });
        }

        // Isolate the self-improvement daemon in its own git CLONE (own .git)
        // so NO git operation it runs can reach the user's repo. If isolation
        // can't be established, DOWNGRADE write autonomy to "propose" and run
        // in the backend cwd — nothing is committed.
        const wantsWriteAutonomy =
          ctx.config.daemon.selfImprovement &&
          ctx.config.daemon.autonomy !== "off";
        const isolatedClone = wantsWriteAutonomy
          ? ensureSelfHealClone(
              ctx.projectPath,
              ctx.config.daemon.selfHealWorktree,
              ctx.config.daemon.selfHealBranch,
            )
          : null;
        const daemonProjectPath = isolatedClone ?? ctx.projectPath;
        const daemonConfig =
          !isolatedClone && ctx.config.daemon.autonomy === "branch"
            ? { ...ctx.config.daemon, autonomy: "propose" as const }
            : ctx.config.daemon;
        // The daemon's tools: when isolated in a clone, a RESTRICTED registry
        // with NO raw git/shell (the escape vector) — its only write-to-git is
        // a commit tool pinned to the clone path. Without a clone it uses the
        // shared read/edit tools but stays in propose mode (no commits).
        const daemonTools = isolatedClone
          ? createDaemonRegistry(isolatedClone)
          : ctx.tools;
        if (isolatedClone) {
          log(`Self-heal daemon isolated in clone: ${isolatedClone}`);
        } else if (wantsWriteAutonomy) {
          log(
            "Self-heal clone unavailable — downgraded autonomy to propose (no commits)",
          );
        }

        // One stable session id for the whole daemon run. Reused for every
        // tick's cost tracking so cost_records group under a single session
        // row instead of spawning an unbounded row per tick.
        const daemonSessionId = `daemon-${Date.now()}`;
        daemonController = new DaemonController({
          config: daemonConfig,
          sessionId: daemonSessionId,
          projectPath: daemonProjectPath,
          runTick: async function* (tickMessage: string) {
            const tickAbort = new AbortController();
            // Scope the path tools (file_edit, grep, glob) to the clone via
            // AsyncLocalStorage. This is best-effort defence in depth for FILE
            // edits; the hard guarantee is `daemonTools` — it contains NO raw
            // git/shell, and its only commit tool is pinned to the clone path
            // with an explicit `git -C <clone>`, so no destructive git can ever
            // reach the user's repo even if this scope leaks.
            enterWorkspace(daemonProjectPath);
            try {
              yield* runLoop(
                [{ role: "user" as const, content: tickMessage }],
                {
                  config: ctx.config,
                  registry: ctx.registry,
                  router: ctx.router,
                  costTracker,
                  tools: daemonTools,
                  sessionId: daemonSessionId,
                  projectPath: daemonProjectPath,
                  systemPrompt: fp,
                  signal: tickAbort.signal,
                },
              );
            } catch (err) {
              yield {
                type: "error",
                error: err instanceof Error ? err.message : String(err),
              } as any;
            }
          },
          getAvailableSkills: () =>
            skills.map((s: any) => ({
              name: s.name,
              description: s.description ?? "",
            })),
          // ── Perception: the desktop daemon wakes up knowing its world ──
          // The sidecar has no God Mode registry, but it CAN see the harness
          // world model (drift), pushed platform events, the BR control
          // plane, and the project — which is what "alive on open" needs.
          getWorldState: () => ({
            connectors: [],
            br: kairosBrStatus,
            project: {
              name: ctx.projectPath.split(/[\\/]/).filter(Boolean).pop(),
              onboarded: true,
            },
          }),
          getOpenDrifts: () => collectOpenDrifts(),
          getPlatformEvents: () =>
            kairosEventStore.listUnconsumed(10).map((e) => ({
              id: e.id,
              source: e.source,
              eventType: e.eventType,
              summary: e.summary,
              receivedAt: e.receivedAt * 1000,
            })),
          onPlatformEventsConsumed: (ids: Array<string | number>) =>
            kairosEventStore.markConsumed(ids.map(String)),
          // ── Self-awareness: router intelligence + BR cost pacing ──
          getRouterIntelligence: () => {
            const momentum = ctx.router.getMomentum();
            return {
              momentum: momentum
                ? {
                    modelId: momentum.modelId,
                    successCount: momentum.successCount,
                    taskType: momentum.taskType,
                  }
                : null,
              recentFailureCount: ctx.router
                .getRecentFailures()
                .filter((f) => Date.now() - f.timestamp < 60_000).length,
              convergenceAlerts: routerModule
                .getConvergenceAlerts(3)
                .map((a) => `${a.type} (${a.taskType}): ${a.detail}`),
            };
          },
          getCostPacing: (defaultMs: number) =>
            costTracker.getAdvisedSleepMs(defaultMs),
          reflectionInterval: ctx.config.daemon.reflectionIntervalTicks,
          approvalGateInterval: ctx.config.daemon.approvalGateIntervalTicks,
          onApprovalGate: async (gate) => {
            // Desktop has no blocking prompt channel yet: surface the gate to
            // every window and continue — budget pacing and ChangeSet
            // boundaries remain the hard controls.
            sendEvent(req.id, "kairos-gate", gate);
            // The organism deliberating with itself, made visible: before a
            // write-autonomy gate, KAIROS convenes a short council to sanity-check
            // what it's about to do. Fire-and-forget — it streams onto the bus so
            // Council/Pulse light up ("council in session"), and never blocks the
            // gate. Only when the daemon actually has write autonomy (else there's
            // nothing high-stakes to deliberate).
            if (wantsWriteAutonomy) {
              try {
                const summary =
                  (gate as { summary?: string; message?: string })?.summary ??
                  (gate as { message?: string })?.message ??
                  "a self-improvement change";
                conveneExchange(
                  `KAIROS is about to apply a self-heal: ${summary}. As a council, is this sound and safe? Flag any risk, then vote proceed or revise.`,
                  { reconciler: "vote" },
                );
              } catch {
                /* deliberation is best-effort; the gate proceeds regardless */
              }
            }
            return true;
          },
          onStateChange: (state: any) => {
            sendEvent(req.id, "kairos-state", state);
          },
        });

        // Run daemon in background — emit events
        (async () => {
          try {
            for await (const event of daemonController.run()) {
              sendEvent(req.id, event.type ?? "daemon-event", event);
            }
          } catch (err) {
            sendEvent(req.id, "daemon-error", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          daemonController = null;
          sendEvent(req.id, "daemon-stopped", {});
        })();

        sendResult(req.id, { ok: true, status: "started" });
        break;
      }

      case "kairos.stop": {
        if (daemonController) {
          daemonController.stop();
          daemonController = null;
          sendResult(req.id, { ok: true });
        } else {
          sendResult(req.id, { ok: false, reason: "Not running" });
        }
        break;
      }

      case "kairos.pause": {
        if (daemonController) {
          daemonController.pause();
          sendResult(req.id, { ok: true });
        } else {
          sendResult(req.id, { ok: false, reason: "Not running" });
        }
        break;
      }

      case "kairos.resume": {
        if (daemonController) {
          daemonController.resume();
          sendResult(req.id, { ok: true });
        } else {
          sendResult(req.id, { ok: false, reason: "Not running" });
        }
        break;
      }

      case "kairos.status": {
        if (daemonController) {
          sendResult(req.id, daemonController.getState());
        } else {
          sendResult(req.id, { status: "stopped" });
        }
        break;
      }

      // ── Organism bus (the single live spine) ─────────────────
      // One subscription replaces the desktop's port-3100 health poll, the
      // useServerData poll, and useKairos polling: the renderer takes the
      // snapshot, then folds every streamed event. `sinceSeq` replays the
      // buffered tail for gapless resume across a reconnect.
      case "organism.subscribe": {
        const { getOrganismBus } = coreModule;
        const bus = getOrganismBus();
        // Tear down any prior subscription on this connection first.
        if (organismUnsub) {
          organismUnsub();
          organismUnsub = null;
        }
        const sinceSeq =
          typeof (params as { sinceSeq?: unknown }).sinceSeq === "number"
            ? (params as { sinceSeq: number }).sinceSeq
            : undefined;
        // Snapshot first so a late joiner sees current state immediately.
        sendEvent(req.id, "organism-snapshot", {
          state: bus.snapshot(),
          seq: bus.currentSeq(),
        });
        // Replay the buffered tail the resumer missed (empty on a fresh join).
        if (sinceSeq !== undefined) {
          for (const ev of bus.since(sinceSeq)) {
            sendEvent(req.id, "organism", ev);
          }
        }
        organismUnsub = bus.subscribe((ev) => {
          sendEvent(req.id, "organism", ev);
        });
        sendResult(req.id, { ok: true, seq: bus.currentSeq() });
        break;
      }

      case "organism.unsubscribe": {
        if (organismUnsub) {
          organismUnsub();
          organismUnsub = null;
        }
        sendResult(req.id, { ok: true });
        break;
      }

      // ── Exchange (models talking to models) ──────────────────
      // Runs a propose→critique→reconcile deliberation. Events stream back on
      // this request AND publish to the organism bus, so Council/Pulse light up
      // live regardless of who started it (owner, escalation, or KAIROS).
      case "exchange.start": {
        const p = params as {
          prompt?: string;
          participants?: Array<{ model: string; provider?: string }>;
          reconciler?: "vote" | "judge" | "owner";
          budgetCap?: number;
        };
        if (!p.prompt) {
          sendError(req.id, "exchange.start requires a prompt");
          break;
        }
        const result = conveneExchange(p.prompt, {
          participants: p.participants,
          reconciler: p.reconciler,
          budgetCap: p.budgetCap,
          streamReqId: req.id,
        });
        if (!result.ok) {
          sendError(req.id, result.error);
          break;
        }
        sendResult(req.id, result);
        break;
      }

      case "exchange.abort": {
        if (exchangeAbort) exchangeAbort.abort();
        sendResult(req.id, { ok: true });
        break;
      }

      case "exchange.list": {
        sendResult(req.id, coreModule.listExchanges());
        break;
      }

      case "exchange.get": {
        const id = String(
          (params as { exchangeId?: unknown }).exchangeId ?? "",
        );
        sendResult(req.id, coreModule.getExchange(id) ?? null);
        break;
      }

      // ── Chat (streaming) ─────────────────────────────────────
      case "chat.stream": {
        const chatParams = ChatStreamParams.parse(params);
        const {
          runAgentLoop,
          buildSystemPrompt,
          loadSkills: loadStreamSkills,
        } = coreModule;
        const { CostTracker: ChatCT } = routerModule;

        const buildResult = buildSystemPrompt(ctx.projectPath);
        let systemPrompt = buildResult.prompt;

        // Inject role-specific prompt if role is set
        if (chatParams.role) {
          systemPrompt = `You are acting as a ${chatParams.role} agent. Prioritize ${chatParams.role}-related tasks and expertise.\n\n${systemPrompt}`;
        }

        // Inject active skills into system prompt
        if (chatParams.activeSkills && chatParams.activeSkills.length > 0) {
          const allSkills = loadStreamSkills(ctx.projectPath);
          const selected = allSkills.filter((s: any) =>
            chatParams.activeSkills!.includes(s.name),
          );
          if (selected.length > 0) {
            const skillBlock = selected
              .map((s: any) => `## Skill: ${s.name}\n${s.content}`)
              .join("\n\n");
            systemPrompt += `\n\n# Active Skills\n\n${skillBlock}`;
          }
        }

        abortController = new AbortController();
        // Prefer an explicit conversation id from the renderer. Fall back to
        // sessionId (HTTP clients / tests), then to a fresh per-turn id.
        const chatSessionId =
          chatParams.conversationId ??
          chatParams.sessionId ??
          `session-${Date.now()}`;
        const costTracker = new ChatCT(ctx.db, ctx.config.budget);

        sendEvent(req.id, "session", { sessionId: chatSessionId });

        // Load prior messages for this conversation so the model sees the
        // full context instead of treating every turn as a fresh session.
        // We only load when the caller supplied a concrete conversationId/
        // sessionId — for an auto-generated id there's nothing to rehydrate.
        const chatMessages: Array<{
          role: "user" | "assistant" | "system";
          content: string;
        }> = [];
        if (chatParams.conversationId || chatParams.sessionId) {
          try {
            const { MessageRepository } = dbModule;
            const msgRepo = new MessageRepository(ctx.db);
            const prior = msgRepo.listBySession(chatSessionId);
            for (const m of prior) {
              if (
                m.role === "user" ||
                m.role === "assistant" ||
                m.role === "system"
              ) {
                chatMessages.push({ role: m.role, content: m.content });
              }
            }
          } catch {
            // If the repo read fails, fall through with just the new turn.
            // Better to drop history than fail the turn outright.
          }
        }
        chatMessages.push({ role: "user", content: chatParams.message });

        // Persist the session row (INSERT OR IGNORE; keeps first project_path
        // if the row already exists) and the new user message BEFORE the
        // model runs. Without this the next turn's listBySession finds
        // nothing and the conversation-history rehydration above is a no-op.
        try {
          ctx.db
            .prepare(
              "INSERT OR IGNORE INTO sessions (id, project_path) VALUES (?, ?)",
            )
            .run(chatSessionId, ctx.projectPath);
          const { MessageRepository } = dbModule;
          const writeRepo = new MessageRepository(ctx.db);
          writeRepo.create(
            chatSessionId,
            "user",
            chatParams.message,
            chatParams.modelId,
          );
        } catch {
          /* DB write failure — continue the turn; best-effort persistence */
        }

        let assistantText = "";
        let assistantModelId: string | undefined;
        try {
          for await (const event of runAgentLoop(chatMessages, {
            config: ctx.config,
            registry: ctx.registry,
            router: ctx.router,
            costTracker,
            tools: ctx.tools,
            sessionId: chatSessionId,
            projectPath: ctx.projectPath,
            systemPrompt,
            preferredModelId: chatParams.modelId,
            signal: abortController.signal,
          })) {
            const e = event as any;
            if (e.type === "text-delta" && typeof e.delta === "string") {
              assistantText += e.delta;
            } else if (e.type === "routing" && e.decision?.model?.id) {
              // AgentEvent routing shape is `{ type: "routing", decision:
              // RoutingDecision }` where decision.model.id is the actual
              // chosen model. Pre-fix we read `e.model?.id` — wrong path,
              // always undefined, so assistantModelId fell through to
              // chatParams.modelId. That meant the DB history persisted
              // the user's REQUESTED model, never the actually-routed one.
              assistantModelId = e.decision.model.id;
            }
            sendEvent(req.id, e.type ?? "event", event);
          }
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            sendEvent(req.id, "aborted", {});
          } else {
            sendEvent(req.id, "error", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Persist the assistant reply. On abort we persist whatever text
        // streamed before the abort — that's the user's conversation history
        // even if it's incomplete.
        if (assistantText) {
          try {
            const { MessageRepository } = dbModule;
            const writeRepo = new MessageRepository(ctx.db);
            writeRepo.create(
              chatSessionId,
              "assistant",
              assistantText,
              assistantModelId ?? chatParams.modelId,
            );
          } catch {
            /* best-effort */
          }
        }

        sendEvent(req.id, "stream-end", {});
        abortController = null;
        break;
      }

      case "chat.abort": {
        if (abortController) {
          abortController.abort();
          sendResult(req.id, { ok: true });
        } else {
          sendResult(req.id, { ok: false, reason: "No active stream" });
        }
        break;
      }

      // ── Security ─────────────────────────────────────────────
      case "security.redteam": {
        const redteamParams = SecurityRedteamParams.parse(params);
        const { runRedTeamSimulation, createDefaultMiddlewarePipeline } =
          coreModule;
        const pipeline = createDefaultMiddlewarePipeline();
        const scorecard = runRedTeamSimulation(pipeline, {
          generations: redteamParams.generations ?? 5,
          populationSize: redteamParams.populationSize ?? 30,
        });
        sendResult(req.id, scorecard);
        break;
      }

      // ── Workflows ─────────────────────────────────────────────
      case "workflow.presets": {
        const { PRESET_WORKFLOWS } = await import("@brainst0rm/workflow");
        sendResult(
          req.id,
          PRESET_WORKFLOWS.map((w: any) => ({
            id: w.id,
            name: w.name ?? w.id,
            description: w.description ?? "",
            steps: (w.steps ?? []).length,
          })),
        );
        break;
      }

      case "workflow.run": {
        const { workflowId, request: userRequest } =
          WorkflowRunParams.parse(params);
        const { runWorkflow, getPresetWorkflow } =
          await import("@brainst0rm/workflow");
        const { AgentManager } = await import("@brainst0rm/agents");

        const definition = getPresetWorkflow(workflowId);

        if (!definition) {
          sendError(req.id, `Unknown workflow: ${workflowId}`);
          break;
        }

        const agentManager = new AgentManager(ctx.db, ctx.config);

        try {
          for await (const event of runWorkflow(
            definition,
            userRequest,
            {},
            {
              config: ctx.config,
              db: ctx.db,
              registry: ctx.registry,
              router: ctx.router,
              costTracker: (ctx.router as any)._costTracker,
              agentManager,
              projectPath: ctx.projectPath,
            },
          )) {
            sendEvent(req.id, event.type ?? "workflow-event", event);
          }
        } catch (err) {
          sendEvent(req.id, "workflow-error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        sendEvent(req.id, "workflow-end", {});
        break;
      }

      // ── Cost aggregation ────────────────────────────────────
      case "cost.summary": {
        const { CostRepository } = dbModule;
        const repo = new CostRepository(ctx.db);
        // Session cost is tracked by the renderer from streaming events;
        // today/month/byModel are authoritative DB aggregations. byModel
        // is capped to the top 8 models so the tab stays scannable.
        sendResult(req.id, {
          today: repo.totalCostToday(),
          month: repo.totalCostThisMonth(),
          byModel: repo.recentByModel(8),
        });
        break;
      }

      // ── Health (for backward compat) ─────────────────────────
      case "health": {
        sendResult(req.id, {
          status: "healthy",
          version: ctx.version,
          uptime_seconds: Math.floor(process.uptime()),
        });
        break;
      }

      default:
        sendError(req.id, `Unknown method: ${req.method}`);
    }
  }
}
