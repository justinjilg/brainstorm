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
import type { Database } from "better-sqlite3";
import type { BrainstormConfig } from "@brainst0rm/config";
import type { BrainstormRouter } from "@brainst0rm/router";

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

export async function startIPCHandler(ctx: IPCContext): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let abortController: AbortController | null = null;
  let daemonController: any = null; // DaemonController instance

  // Pre-import core modules to avoid dynamic import deadlocks inside handlers
  const coreModule = await import("@brainst0rm/core");
  const dbModule = await import("@brainst0rm/db");
  const routerModule = await import("@brainst0rm/router");

  // Log to stderr so it doesn't pollute the NDJSON stdout channel
  const log = (msg: string) => process.stderr.write(`[ipc] ${msg}\n`);
  log(`Brainstorm IPC v${ctx.version} ready`);

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

    try {
      await dispatch(req, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(req.id, msg);
      log(`Error handling ${req.method}: ${msg}`);
    }
  });

  rl.on("close", () => {
    log("stdin closed, exiting");
    process.exit(0);
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
        const { name, content, type, source } = params as {
          name: string;
          content: string;
          type?: string;
          source?: string;
        };
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
        } = params as {
          id: string;
          tier?: string;
          content?: string;
        };
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
        const { id: memId } = params as { id: string };
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
        const { ConversationRepository } = dbModule;
        const repo = new ConversationRepository(ctx.db);
        const convs = repo.list(params.project as string | undefined);
        sendResult(req.id, convs);
        break;
      }

      case "conversations.create": {
        const { ConversationRepository } = dbModule;
        const repo = new ConversationRepository(ctx.db);
        const conv = repo.create(
          (params.projectPath as string) ?? ctx.projectPath,
          {
            name: (params.name as string) ?? "Untitled",
            description: params.description as string | undefined,
            modelOverride: params.modelOverride as string | undefined,
          },
        );
        sendResult(req.id, conv);
        break;
      }

      case "conversations.fork": {
        const { ConversationRepository } = dbModule;
        const repo = new ConversationRepository(ctx.db);
        const conv = repo.fork(
          params.id as string,
          params.name as string | undefined,
        );
        sendResult(req.id, conv);
        break;
      }

      case "conversations.handoff": {
        const { ConversationRepository } = dbModule;
        const repo = new ConversationRepository(ctx.db);
        const conv = repo.update(params.id as string, {
          modelOverride: params.modelId as string,
        });
        sendResult(req.id, conv);
        break;
      }

      case "conversations.messages": {
        const { MessageRepository } = dbModule;
        const repo = new MessageRepository(ctx.db);
        const messages = repo.listBySession(params.sessionId as string);
        sendResult(req.id, messages);
        break;
      }

      // ── Config ───────────────────────────────────────────────
      case "config.get": {
        const { loadConfig: loadCfg } =
          await import("@brainst0rm/config"); /* config only used once */
        const config = loadCfg();
        // Scrub secrets — only send safe settings to renderer
        const safeProviders = (config.providers ?? []).map((p: any) => ({
          name: p.name,
          enabled: p.enabled,
          // Strip apiKey, apiKeyName, secret, token fields
        }));
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
        const { frontmatter: fp } = buildSP(ctx.projectPath);
        const skills = loadSk(ctx.projectPath);
        const costTracker = new CT(ctx.db, ctx.config.budget);

        daemonController = new DaemonController({
          config: ctx.config.daemon,
          sessionId: `daemon-${Date.now()}`,
          projectPath: ctx.projectPath,
          runTick: async function* (tickMessage: string) {
            const tickAbort = new AbortController();
            try {
              yield* runLoop(
                [{ role: "user" as const, content: tickMessage }],
                {
                  config: ctx.config,
                  registry: ctx.registry,
                  router: ctx.router,
                  costTracker,
                  tools: ctx.tools,
                  sessionId: `daemon-tick-${Date.now()}`,
                  projectPath: ctx.projectPath,
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
        const {
          runAgentLoop,
          buildSystemPrompt,
          loadSkills: loadStreamSkills,
        } = coreModule;
        const { CostTracker: ChatCT } = routerModule;

        let { frontmatter } = buildSystemPrompt(ctx.projectPath);

        // Inject role-specific prompt if role is set
        const role = params.role as string | undefined;
        if (role) {
          frontmatter = `You are acting as a ${role} agent. Prioritize ${role}-related tasks and expertise.\n\n${frontmatter}`;
        }

        // Inject active skills into system prompt
        const activeSkills = params.activeSkills as string[] | undefined;
        if (activeSkills && activeSkills.length > 0) {
          const allSkills = loadStreamSkills(ctx.projectPath);
          const selected = allSkills.filter((s: any) =>
            activeSkills.includes(s.name),
          );
          if (selected.length > 0) {
            const skillBlock = selected
              .map((s: any) => `## Skill: ${s.name}\n${s.content}`)
              .join("\n\n");
            frontmatter += `\n\n# Active Skills\n\n${skillBlock}`;
          }
        }

        abortController = new AbortController();
        const chatSessionId =
          (params.sessionId as string) ?? `session-${Date.now()}`;
        const costTracker = new ChatCT(ctx.db, ctx.config.budget);

        sendEvent(req.id, "session", { sessionId: chatSessionId });

        // Build messages array — user message
        const chatMessages = [
          { role: "user" as const, content: params.message as string },
        ];

        try {
          for await (const event of runAgentLoop(chatMessages, {
            config: ctx.config,
            registry: ctx.registry,
            router: ctx.router,
            costTracker,
            tools: ctx.tools,
            sessionId: chatSessionId,
            projectPath: ctx.projectPath,
            systemPrompt: frontmatter,
            preferredModelId: params.modelId as string | undefined,
            signal: abortController.signal,
          })) {
            sendEvent(req.id, (event as any).type ?? "event", event);
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
        const { RedTeamEngine } = coreModule;
        const engine = new RedTeamEngine();
        const scorecard = await engine.run({
          generations: (params.generations as number) ?? 5,
          populationSize: (params.populationSize as number) ?? 30,
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
        const { runWorkflow, getPresetWorkflow } =
          await import("@brainst0rm/workflow");
        const { AgentManager } = await import("@brainst0rm/agents");

        const workflowId = params.workflowId as string;
        const userRequest = params.request as string;
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
