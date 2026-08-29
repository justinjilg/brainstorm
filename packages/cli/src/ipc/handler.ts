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
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Ensure the self-improvement daemon has its OWN git worktree so its edits and
 * commits physically cannot touch the user's main working tree. Created from
 * the current HEAD on the configured branch if missing. Returns the absolute
 * worktree path, or null if isolation could not be established (the caller then
 * declines to enable write autonomy).
 *
 * IMPORTANT: we deliberately do NOT symlink the main repo's node_modules into
 * the worktree. Doing so turns the autonomous agent's writes (e.g. a dependency
 * install) into mutations of the user's REAL deps — that exact mistake once
 * corrupted the main install mid-session. The worktree gets its own deps
 * out-of-band (a real `pnpm install` there is isolated) or the daemon's verify
 * is limited to what the toolchain resolves without a full install. The charter
 * also forbids the daemon from running package installs.
 */
function ensureSelfHealWorktree(
  repoPath: string,
  worktreeSetting: string,
  branch: string,
): string | null {
  if (!worktreeSetting) return null;
  const expanded = worktreeSetting.startsWith("~")
    ? join(homedir(), worktreeSetting.slice(1))
    : worktreeSetting;
  // Absolutize against the repo so Node's existsSync and git's cwd-relative
  // resolution can never disagree on where the worktree is.
  const worktree = resolve(repoPath, expanded);
  const gitq = (args: string[]): string => {
    try {
      return execFileSync("git", args, {
        cwd: repoPath,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      }).toString();
    } catch (err) {
      // An empty result is expected for probes like `rev-parse --verify` on a
      // not-yet-created branch. A timeout or a spawn error (git missing, cwd
      // gone) is NOT expected — surface it so a broken environment is visible
      // rather than looking like "branch absent".
      const e = err as { code?: string; signal?: string };
      if (e?.code === "ETIMEDOUT" || e?.signal) {
        process.stderr.write(
          `[ipc] git ${args[0]} failed abnormally (${e.code ?? e.signal}) in ${repoPath}\n`,
        );
      }
      return "";
    }
  };
  // Canonicalize for comparison so symlinked prefixes (e.g. macOS
  // /Users → /System/Volumes/Data/Users) and case differences don't make an
  // already-registered worktree look new.
  const canon = (p: string): string => {
    try {
      return existsSync(p) ? realpathSync(p) : p;
    } catch {
      return p;
    }
  };
  const worktreeReal = canon(worktree);
  try {
    // Already a registered worktree at this path? Reuse it — `git worktree add`
    // would otherwise fail on the existing directory. Match on the porcelain
    // "worktree <path>" lines so a leftover/untracked dir is handled too.
    const registered = gitq(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .some((l) => canon(l.slice("worktree ".length)) === worktreeReal);
    // Only trust a registered/existing worktree if its directory is actually
    // present. Git keeps a worktree in `worktree list` even after the directory
    // is deleted externally (until `git worktree prune`); returning that stale
    // path would send every later cwd-scoped op against a missing dir instead
    // of failing closed. If it's registered-but-gone, prune and recreate.
    if (
      (registered || existsSync(join(worktree, ".git"))) &&
      existsSync(worktree)
    )
      return worktree;
    if (registered) gitq(["worktree", "prune"]);

    // If a non-worktree directory is squatting the path, don't clobber it —
    // fail closed so autonomy downgrades to propose rather than committing
    // somewhere unexpected.
    if (existsSync(worktree)) return null;

    const branchExists =
      gitq(["rev-parse", "--verify", branch]).trim().length > 0;
    const args = branchExists
      ? ["worktree", "add", worktree, branch]
      : ["worktree", "add", worktree, "-b", branch];
    // Bounded so a hung git (index lock wait, credential prompt) can never
    // block the daemon tick indefinitely — it times out and fails closed.
    execFileSync("git", args, { cwd: repoPath, stdio: "pipe", timeout: 10000 });
    return worktree;
  } catch (err) {
    // Surface WHY isolation could not be established — otherwise the caller
    // silently downgrades autonomy to propose and the operator has no way to
    // tell an intentional config from a broken worktree (branch checked out
    // elsewhere, permissions, disk). Fail closed, but never silently.
    const detail =
      err instanceof Error ? err.message.split("\n")[0] : String(err);
    process.stderr.write(
      `[ipc] self-heal worktree could not be established at ${worktree}: ${detail}\n`,
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

export async function startIPCHandler(ctx: IPCContext): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let abortController: AbortController | null = null;
  let daemonController: any = null; // DaemonController instance
  let pendingDispatches = 0;
  let stdinClosed = false;

  // Pre-import core modules to avoid dynamic import deadlocks inside handlers
  const coreModule = await import("@brainst0rm/core");
  const dbModule = await import("@brainst0rm/db");
  const routerModule = await import("@brainst0rm/router");

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

        // Isolate the self-improvement daemon in its own git worktree so its
        // edits/commits can never touch the user's main working tree. If we
        // can't establish isolation, fall back to the backend cwd but DOWNGRADE
        // write autonomy to "propose" so nothing is committed into a shared,
        // possibly-dirty tree.
        const wantsWriteAutonomy =
          ctx.config.daemon.selfImprovement &&
          ctx.config.daemon.autonomy !== "off";
        const isolatedWorktree = wantsWriteAutonomy
          ? ensureSelfHealWorktree(
              ctx.projectPath,
              ctx.config.daemon.selfHealWorktree,
              ctx.config.daemon.selfHealBranch,
            )
          : null;
        const daemonProjectPath = isolatedWorktree ?? ctx.projectPath;
        const daemonConfig =
          !isolatedWorktree && ctx.config.daemon.autonomy === "branch"
            ? { ...ctx.config.daemon, autonomy: "propose" as const }
            : ctx.config.daemon;
        if (isolatedWorktree) {
          log(`Self-heal daemon isolated in worktree: ${isolatedWorktree}`);
        } else if (wantsWriteAutonomy) {
          log(
            "Self-heal worktree unavailable — downgraded autonomy to propose (no commits to shared tree)",
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
            // Scope every path/repo tool (file_edit, shell, git_*, gh_*) in this
            // tick to the isolated worktree via AsyncLocalStorage. We use
            // enterWith (not run()) because this is a generator that yields the
            // agent's event stream — the same pattern the subagent runner uses
            // for a spawned project root. It binds the store to THIS tick's
            // async chain; the interactive chat runs on a separate async root
            // (its own stdin 'line' event) and never inherits it, so the two
            // never cross-contaminate. A fresh runTick invocation re-binds each
            // tick, so nothing persists between ticks either.
            enterWorkspace(daemonProjectPath);
            try {
              yield* runLoop(
                [{ role: "user" as const, content: tickMessage }],
                {
                  config: ctx.config,
                  registry: ctx.registry,
                  router: ctx.router,
                  costTracker,
                  tools: ctx.tools,
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
