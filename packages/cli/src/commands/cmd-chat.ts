/**
 * `brainstorm` chat commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { type StrategyName } from "@brainst0rm/shared";
import { loadConfig } from "@brainst0rm/config";
import { getDb, RoutingOutcomeRepository } from "@brainst0rm/db";
import {
  createProviderRegistry,
  getBrainstormApiKey,
  isCommunityKey,
} from "@brainst0rm/providers";
import {
  BrainstormRouter,
  CostTracker,
  attachStreamToLearnedStrategy,
  getConvergenceAlerts,
} from "@brainst0rm/router";
import {
  createDefaultToolRegistry,
  createWiredMemoryTool,
  createWiredPipelineTool,
  createWiredCodeGraphTools,
  configureSandbox,
} from "@brainst0rm/tools";
import {
  runAgentLoop,
  buildSystemPrompt,
  buildToolAwarenessSection,
  SessionManager,
  PermissionManager,
  createSubagentTool,
  spawnSubagent,
  createDefaultMiddlewarePipeline,
} from "@brainst0rm/core";
import type { OutputStyle } from "@brainst0rm/core";
import { ROLES, type RoleId } from "./roles.js";
import { collectOpenDrifts } from "../perception/drift.js";
import {
  createGatewayClient,
  formatGatewayFeedback,
  RoutingEventStream,
} from "@brainst0rm/gateway";
import { BrainstormVault } from "@brainst0rm/vault";
import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { maskSecret } from "../util/mask-secret.js";
import {
  PROVIDER_KEY_NAMES,
  resolveProviderKeys,
  buildCompactionCallbacks,
  startSyncWorkerIfConfigured,
  connectMCPServers,
  runMemoryExtractionTeardown,
  VAULT_PATH,
  printResumeSummary,
} from "./_context.js";

export function registerChatCommands(program: Command): void {
  program
    .command("chat", { isDefault: true })
    .description("Start an interactive chat session")
    .option("--simple", "Use simple readline interface instead of TUI")
    .option(
      "--daemon",
      "Daemon mode — model-driven tick loop (requires --simple for MVP)",
    )
    .option("--continue", "Resume the most recent session")
    .option("--resume <id>", "Resume a specific session by ID")
    .option("--fork <id>", "Fork a session (copy history, new session)")
    .option("--lfg", "Full auto mode — skip all permission confirmations")
    .option(
      "--strategy <name>",
      "Routing strategy: cost-first, quality-first, combined, capability",
    )
    .option("--verbose-routing", "Print routing decisions to stderr")
    .option(
      "--fast",
      "Fast startup — skip provider discovery, MCP connections, and eval probes",
    )
    .action(
      async (opts: {
        simple?: boolean;
        daemon?: boolean;
        continue?: boolean;
        resume?: string;
        fork?: string;
        lfg?: boolean;
        strategy?: string;
        verboseRouting?: boolean;
        fast?: boolean;
      }) => {
        const config = loadConfig();

        // --daemon requires --simple for MVP
        if (opts.daemon && !opts.simple) {
          console.error(
            "  Daemon mode requires --simple for MVP. Run: brainstorm chat --simple --daemon",
          );
          process.exit(1);
        }

        // --lfg: full auto mode, skip all permission confirmations
        if (opts.lfg) {
          config.general.defaultPermissionMode = "auto";
        }

        // --fast: skip heavy initialization for <200ms startup
        if (opts.fast) {
          (config.general as any).skipProviderDiscovery = true;
          (config.general as any).skipEvalProbes = true;
        }

        // Boot Phase A: sync initialization (instant)
        const db = getDb();
        const projectPath = process.cwd();
        const tools = createDefaultToolRegistry({ daemon: opts.daemon });

        // Construct the BR gateway client early so MemoryManager can receive
        // it as a constructor arg and kick off the pull path. Without this,
        // Week 1's pullFromGateway() is dead code on the chat path.
        //
        // Returns null if BRAINSTORM_API_KEY isn't set — that's fine,
        // MemoryManager handles a null gateway gracefully (local-only mode).
        const chatGateway = createGatewayClient();

        // Wire memory tool — replace stub with MemoryManager-backed implementation
        const { MemoryManager: ChatMemoryManager } =
          await import("@brainst0rm/core");
        const chatMemory = new ChatMemoryManager(projectPath, chatGateway);
        const wiredMemoryTool = createWiredMemoryTool(chatMemory);
        tools.unregister("memory");
        tools.register(wiredMemoryTool);

        // Fire pullFromGateway in the background — we don't block boot on a
        // network round-trip, but the pull will complete before the first
        // agent turn in most cases. Status visible via `brainstorm sync status`.
        if (chatGateway) {
          chatMemory.pullFromGateway().catch(() => {
            // Errors captured into MemoryManager.getPullStatus()
          });
        }

        // Start the sync queue drain worker if a gateway is configured.
        // This is the missing link — without it, retry queue rows sit forever
        // and the fire-and-forget push path stays broken. We start the worker
        // for its side effect; the returned handle isn't held because the
        // worker self-manages via its own scheduler.
        await startSyncWorkerIfConfigured(chatGateway, db);

        // Wire code graph tools — tree-sitter knowledge graph for structural queries
        try {
          const { CodeGraph } = await import("@brainst0rm/code-graph");
          const codeGraph = new CodeGraph({ projectPath });
          const wiredCodeGraphTools = createWiredCodeGraphTools(codeGraph);
          for (const tool of wiredCodeGraphTools) {
            tools.unregister(tool.name);
            tools.register(tool);
          }
        } catch (e) {
          // code-graph package may not be built — tools stay as stubs
        }

        configureSandbox(
          config.shell.sandbox,
          projectPath,
          config.shell.maxOutputBytes,
          config.shell.containerImage,
          config.shell.containerTimeout,
          config.shell.sandboxPool,
        );
        const permissionManager = new PermissionManager(
          config.general.defaultPermissionMode,
          config.permissions,
        );
        let currentOutputStyle: OutputStyle =
          (config.general.outputStyle as OutputStyle) ?? "concise";
        let currentRole: string | undefined;
        const sessionManager = new SessionManager(db);
        const middleware = createDefaultMiddlewarePipeline(projectPath);

        // Boot Phase B: async key resolution runs in parallel with system prompt build
        const [resolvedKeys, promptResult] = await Promise.all([
          resolveProviderKeys(),
          Promise.resolve(buildSystemPrompt(projectPath, currentOutputStyle)),
        ]);
        let {
          prompt: systemPrompt,
          segments: systemSegments,
          frontmatter,
        } = promptResult;
        // Tool awareness goes in the cacheable zone (stable within session)
        const toolSection = buildToolAwarenessSection(tools.listTools());
        systemPrompt += toolSection;
        if (systemSegments.length > 0) {
          systemSegments[0] = {
            text: systemSegments[0].text + toolSection,
            cacheable: true,
          };
        }
        const resolvedBRKey =
          resolvedKeys.get("BRAINSTORM_API_KEY") ?? getBrainstormApiKey();
        const isCommunityTier = isCommunityKey(resolvedBRKey);
        if (resolvedBRKey) process.env._BR_RESOLVED_KEY = resolvedBRKey;

        // Boot Phase C: provider registry + MCP connections in parallel
        //
        // P2b — wire the BR envelope listener into routing_audit. Every chat
        // turn that flows through brainstormrouter SaaS now writes a row
        // keyed on x-request-id. Closes the v15 audit-chain overclaim: prior
        // to this we said "the audit-hash IS the chain" but never persisted
        // the rows the hash chained.
        const { RoutingAuditRepository, wireRoutingAudit } =
          await import("@brainst0rm/db");
        const auditRepo = new RoutingAuditRepository(db);
        const onEnvelope = wireRoutingAudit(auditRepo);

        const [registry] = await Promise.all([
          createProviderRegistry(config, resolvedKeys, { onEnvelope }),
          opts.fast
            ? Promise.resolve()
            : connectMCPServers(
                tools,
                config,
                resolvedKeys.get("BRAINSTORM_API_KEY"),
              ),
        ]);

        // Boot Phase D: final assembly (depends on everything above)
        const costTracker = new CostTracker(db, config.budget);

        // Startup budget diagnostic: warn if the configured daily/monthly
        // cap is already exceeded by prior sessions. Fixes Dogfood #1 Bug 4
        // where the daemon would circuit-break on tick #1 with an opaque
        // error. Now the user sees a clear warning BEFORE any work starts.
        const budgetDiag = costTracker.diagnoseBudgetAtStartup();
        if (budgetDiag) {
          const prefix = budgetDiag.severity === "error" ? "✗" : "⚠";
          process.stderr.write(
            `\n  ${prefix} Budget: ${budgetDiag.message}\n\n`,
          );
          if (budgetDiag.severity === "error" && config.budget.hardLimit) {
            process.stderr.write(
              `  Fix: raise the cap in ~/.brainstorm/config.toml, or switch to\n` +
                `  [budget] perSession = N (hardLimit = true) so the daily total\n` +
                `  doesn't block new sessions.\n\n`,
            );
          }
        }

        const routingOutcomeRepo = new RoutingOutcomeRepository(db);
        const historicalStats = routingOutcomeRepo.loadAggregated();
        const router = new BrainstormRouter(
          config,
          registry,
          costTracker,
          frontmatter,
          historicalStats,
        );
        // Paid keys or direct provider keys get quality-first by default.
        // Community tier without own keys stays on BR server-side routing.
        const hasOwnKeys =
          !!resolvedKeys.get("DEEPSEEK_API_KEY") ||
          !!resolvedKeys.get("ANTHROPIC_API_KEY") ||
          !!resolvedKeys.get("OPENAI_API_KEY") ||
          !!resolvedKeys.get("MOONSHOT_API_KEY") ||
          !!resolvedKeys.get("GOOGLE_GENERATIVE_AI_API_KEY");
        if (opts.strategy) {
          router.setStrategy(opts.strategy as StrategyName);
        }
        // Otherwise: respect config.general.defaultStrategy (set by router constructor).
        // Previously this code force-overrode to quality-first when the user had their
        // own API keys. That defeated cost-aware routing — every task routed to the
        // single highest-quality model (Sonnet 4.6 every time), starving the learning
        // loop and ignoring the task classifier. The "combined" default already
        // escalates complex/expert tasks to quality-first internally; simple/moderate
        // tasks should benefit from cost-first or weighted scoring.
        // The auto-activated "capability" strategy (when eval data exists) is also
        // preserved, since it's a deliberate signal that better data exists.

        // Register the subagent tool (model can spawn focused subagents)
        const subagentTool = createSubagentTool({
          config,
          registry,
          router,
          costTracker,
          tools,
          projectPath,
          permissionCheck: (name, perm) => permissionManager.check(name, perm),
          containerIsolation: config.shell.sandbox === "container",
          parentSegments: systemSegments,
        });
        tools.register(subagentTool);

        // Boot Phase E: God Mode connectors (parallel, non-blocking)
        let godModeResult: Awaited<
          ReturnType<typeof import("@brainst0rm/godmode").connectGodMode>
        > | null = null;
        // Auto-enable God Mode when any connector key is present in env
        const hasAnyConnectorKey = !!(
          process.env.BRAINSTORM_MSP_API_KEY ||
          process.env.BRAINSTORM_EMAIL_API_KEY ||
          process.env.BRAINSTORM_VM_API_KEY ||
          process.env._GM_MSP_KEY ||
          process.env._GM_EMAIL_KEY ||
          process.env._GM_VM_KEY ||
          process.env._GM_AGENT_KEY
        );
        const godmodeEnabled = config.godmode.enabled || hasAnyConnectorKey;

        if (godmodeEnabled && !opts.fast) {
          try {
            const {
              connectGodMode,
              createProductConnectors,
              setAuditPersister: setAuditPersisterChat,
            } = await import("@brainst0rm/godmode");
            const { ChangeSetLogRepository: CSLogChat } =
              await import("@brainst0rm/db");

            // Wire audit persistence for chat sessions
            const csLogChat = new CSLogChat(db);
            setAuditPersisterChat((entry) => {
              csLogChat.log({
                changesetId: entry.changesetId,
                connector: entry.connector,
                action: entry.action,
                description: entry.description,
                riskScore: entry.riskScore,
                status: entry.status,
                changesJson: entry.changesJson,
                simulationJson: entry.simulationJson,
                rollbackJson: entry.rollbackJson,
                createdAt: entry.createdAt,
                executedAt: entry.executedAt,
                sessionId: null,
              });
            });

            const mspBaseUrlChat =
              process.env.BRAINSTORM_MSP_URL ?? "https://brainstormmsp.ai";
            const defaultConnectors: Record<string, any> = {
              msp: {
                enabled: true,
                baseUrl: mspBaseUrlChat,
                apiKeyName: "BRAINSTORM_MSP_API_KEY",
              },
            };
            const mergedGmConfig = {
              ...config.godmode,
              connectors: {
                ...defaultConnectors,
                ...config.godmode.connectors,
              },
            };
            const activeConnectors =
              await createProductConnectors(mergedGmConfig);

            // Add typed agent connector (routes through MSP's agent management API)
            const { createAgentConnector: createAgentChat } =
              await import("@brainst0rm/godmode/connectors/agent");
            activeConnectors.push(
              createAgentChat({
                enabled: true,
                baseUrl: mspBaseUrlChat,
                apiKeyName: "_GM_AGENT_KEY",
              }),
            );

            godModeResult = await connectGodMode(
              tools,
              mergedGmConfig,
              activeConnectors,
            );

            if (godModeResult.connectedSystems.length > 0) {
              process.stderr.write(
                `[godmode] Connected: ${godModeResult.connectedSystems.map((s) => s.displayName).join(", ")} (${godModeResult.totalTools} tools)\n`,
              );
              // Inject God Mode capabilities into system prompt
              if (godModeResult.promptSegment?.text) {
                systemPrompt += "\n" + godModeResult.promptSegment.text;
                if (systemSegments.length > 0) {
                  systemSegments.push(godModeResult.promptSegment);
                }
              }
            }
          } catch (err) {
            process.stderr.write(
              `[godmode] Init failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }

        // Preferred model override — mutable so /model can change it
        // Community tier without direct provider keys: force brainstormrouter/auto
        // If user has their own keys (DEEPSEEK, ANTHROPIC, etc.), let local routing use them
        const hasDirectProviderKeys =
          !!resolvedKeys.get("DEEPSEEK_API_KEY") ||
          !!resolvedKeys.get("ANTHROPIC_API_KEY") ||
          !!resolvedKeys.get("OPENAI_API_KEY") ||
          !!resolvedKeys.get("GOOGLE_GENERATIVE_AI_API_KEY") ||
          !!resolvedKeys.get("MOONSHOT_API_KEY");
        // Model selection: let the router decide unless the user explicitly pins
        // via --model or /model. Community-tier users without their own keys fall
        // through to the hosted brainstormrouter/auto endpoint.
        //
        // Previously this force-pinned moonshot/kimi-k2.5 whenever MOONSHOT_API_KEY
        // was set, which bypassed the router entirely and prevented task-type-aware
        // model selection. The capability strategy will still pick Kimi for
        // code-generation work (it has the highest capability score in that
        // category) but will now pick Gemini Flash for simple tasks, Haiku for
        // conversations, etc. — the whole fleet gets used.
        let preferredModelId: string | undefined =
          isCommunityTier && !hasDirectProviderKeys
            ? "brainstormrouter/auto"
            : undefined;

        // Session management: resume, fork, or start new
        let session: any;
        if (opts.fork) {
          session = sessionManager.fork(opts.fork);
          if (!session) {
            console.error(`  Session '${opts.fork}' not found.`);
            process.exit(1);
          }
          console.log(
            `  Forked session ${opts.fork.slice(0, 8)} -> ${session.id.slice(0, 8)}`,
          );
        } else if (opts.resume) {
          session = sessionManager.resume(opts.resume);
          if (!session) {
            console.error(`  Session '${opts.resume}' not found.`);
            process.exit(1);
          }
          printResumeSummary(session, sessionManager);
        } else if (opts.continue) {
          if (opts.daemon) {
            // Daemon --continue: resume the last daemon session specifically
            const { SessionRepository: SessRepoResume } =
              await import("@brainst0rm/db");
            const sessRepoResume = new SessRepoResume(db);
            const lastDaemon = sessRepoResume.getLastDaemon(projectPath);
            if (lastDaemon) {
              session = sessionManager.resume(lastDaemon.id);
              if (session) {
                console.log(
                  `  Resuming daemon session ${lastDaemon.id.slice(0, 8)} (${lastDaemon.tickCount ?? 0} ticks, $${(lastDaemon.totalCost ?? 0).toFixed(4)})`,
                );
              } else {
                session = sessionManager.start(projectPath);
              }
            } else {
              session = sessionManager.start(projectPath);
            }
          } else {
            session = sessionManager.resumeLatest(projectPath);
            if (!session) {
              session = sessionManager.start(projectPath);
            } else {
              printResumeSummary(session, sessionManager);
            }
          }
        } else {
          session = sessionManager.start(projectPath);
        }

        const localCount = registry.models.filter((m) => m.isLocal).length;
        const cloudCount = registry.models.filter((m) => !m.isLocal).length;

        if (opts.simple) {
          // Simple readline fallback
          const readline = await import("node:readline/promises");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          console.log(`\n  🧠 brainstorm v0.1.0`);
          console.log(
            `  Strategy: ${router.getActiveStrategy()} | Models: ${localCount} local, ${cloudCount} cloud`,
          );
          console.log(`  Project: ${projectPath}`);
          if (isCommunityTier)
            console.log(
              `  Community tier (5 req/min, cheap models). Set BRAINSTORM_API_KEY for full access.`,
            );
          console.log(
            `  Commands: /quit, /model <id>, /strategy <name>, /compact`,
          );
          if (opts.daemon)
            console.log(
              `  DAEMON MODE: tick every ${config.daemon.tickIntervalMs / 1000}s, max ${config.daemon.maxTicksPerSession} ticks`,
            );
          console.log(`  Ctrl+C to interrupt, Ctrl+D to exit.\n`);

          // ── Daemon Mode ──────────────────────────────────────────
          if (opts.daemon) {
            const { DaemonController, DailyLog } =
              await import("@brainst0rm/core");
            const { DailyLogRepository, SessionRepository: SessRepo } =
              await import("@brainst0rm/db");

            const sessRepo = new SessRepo(db);
            sessRepo.markDaemon(session.id, config.daemon.tickIntervalMs);

            const dailyLogRepo = new DailyLogRepository(db);
            const dailyLog = new DailyLog({
              logDir: config.daemon.dailyLogDir,
              repo: dailyLogRepo,
              sessionId: session.id,
            });

            dailyLog.append("Daemon session started", {
              eventType: "start",
            });

            // Wire scheduler so due tasks appear in tick messages
            const { TriggerRunner } = await import("@brainst0rm/scheduler");
            const triggerRunner = new TriggerRunner(db);

            // Wire memory and skills into daemon tick context
            const { MemoryManager, loadSkills } =
              await import("@brainst0rm/core");
            const daemonMemory = new MemoryManager(projectPath);
            const daemonSkills = loadSkills(projectPath);

            // Wire memory tool in daemon mode — same as chat mode
            const wiredDaemonMemory = createWiredMemoryTool(daemonMemory);
            tools.unregister("memory");
            tools.register(wiredDaemonMemory);

            // Wire pipeline dispatch tool — enables daemon to invoke multi-phase orchestration
            const { createPipelineDispatcher, runOrchestrationPipeline } =
              await import("@brainst0rm/core");
            const pipelineDispatcher = createPipelineDispatcher({
              config,
              registry,
              router,
              costTracker,
              tools,
              projectPath,
            });
            const wiredPipeline = createWiredPipelineTool(
              async (request, opts) => {
                const phases: Array<{
                  phase: string;
                  output: string;
                  cost: number;
                }> = [];
                let totalCost = 0;
                for await (const event of runOrchestrationPipeline(
                  request,
                  pipelineDispatcher,
                  {
                    projectPath,
                    phases: opts?.phases as any,
                    dryRun: opts?.dryRun,
                  },
                )) {
                  if (event.type === "phase-completed") {
                    phases.push({
                      phase: event.result.phase,
                      output: event.result.output ?? "",
                      cost: event.result.cost ?? 0,
                    });
                    totalCost += event.result.cost ?? 0;
                  }
                }
                return { phases, totalCost };
              },
            );
            tools.unregister("pipeline_dispatch");
            tools.register(wiredPipeline);

            // ── Sector Intelligence Integration ─────────────────────
            // Wire code-graph sector agents into the daemon tick loop.
            // If sectors are detected, each tick targets the sector with
            // the oldest lastTickAt. The sector's tier determines model
            // selection via BrainstormRouter's QualityTier system.
            let sectorAgents: any[] = [];
            let sectorGraph: any = null;
            let _selectNextSector: any = null;
            let _recordSectorTick: any = null;
            try {
              const {
                CodeGraph,
                initializeAdapters,
                executePipeline,
                createDefaultPipeline,
                detectCommunities,
                assignAgentsToSectors,
                selectNextSector: sns,
                recordSectorTick: rst,
              } = await import("@brainst0rm/code-graph");
              _selectNextSector = sns;
              _recordSectorTick = rst;

              sectorGraph = new CodeGraph({ projectPath });
              const stats = sectorGraph.extendedStats();

              // Auto-index if graph is empty
              if (stats.files === 0) {
                await initializeAdapters();
                await executePipeline(createDefaultPipeline(), {
                  projectPath,
                  graph: sectorGraph,
                  results: new Map(),
                });
              }

              // Detect communities and assign agents
              if (sectorGraph.extendedStats().nodes > 0) {
                const { communities } = detectCommunities(sectorGraph);
                sectorAgents = assignAgentsToSectors(communities, sectorGraph, {
                  writeAgentFiles: true,
                  projectPath,
                  minNodes: 3,
                });
                if (sectorAgents.length > 0) {
                  dailyLog.append(
                    `Sector agents: ${sectorAgents.length} (${sectorAgents.map((a: any) => `${a.sectorName}:${a.tier}`).join(", ")})`,
                    { eventType: "sector-init" },
                  );
                }
              }
            } catch (err: any) {
              // Code graph not available — daemon runs without sectors
              dailyLog.append(
                `Sector intelligence unavailable: ${err.message}`,
                {
                  eventType: "warning",
                },
              );
            }

            // ── Awakening: perception + intelligence wiring (KAIROS senses) ──
            const { PlatformEventRepository } = await import("@brainst0rm/db");
            const platformEventStore = new PlatformEventRepository(db);

            // BR control-plane probe — fired once at wake, rendered into every
            // tick's <perception> block so the daemon knows whether the hosted
            // intelligence plane is reachable.
            const daemonGateway = createGatewayClient();
            let brStatus: {
              connected: boolean;
              models?: number;
              note?: string;
            } = daemonGateway
              ? { connected: true }
              : { connected: false, note: "BRAINSTORM_API_KEY not set" };
            if (daemonGateway) {
              void daemonGateway
                .listModels()
                .then((models: unknown) => {
                  const count = Array.isArray(models)
                    ? models.length
                    : ((models as { data?: unknown[] })?.data?.length ??
                      undefined);
                  brStatus = { connected: true, models: count };
                })
                .catch((err: unknown) => {
                  brStatus = {
                    connected: false,
                    note: `BR unreachable: ${err instanceof Error ? err.message : String(err)}`,
                  };
                });
            }

            // Approval-gate answers use the daemon's own readline; assigned
            // after the interface is created below.
            let gateQuestion: ((prompt: string) => Promise<string>) | null =
              null;

            const daemon = new DaemonController({
              config: config.daemon,
              sessionId: session.id,
              projectPath,
              runTick: (tickMessage: string) => {
                // If sector agents are configured, overlay sector context
                let finalMessage = tickMessage;
                let currentSectorId: string | undefined;

                if (
                  sectorAgents.length > 0 &&
                  sectorGraph &&
                  _selectNextSector
                ) {
                  try {
                    const tick = _selectNextSector(sectorAgents, sectorGraph);
                    if (tick) {
                      finalMessage =
                        tick.tickMessage + "\n\n---\n\n" + tickMessage;
                      // sectorBudget is computed but not threaded into
                      // runAgentLoop yet — sector budgets land with the
                      // sector orchestration work in PRD Phase 1+. Until
                      // then we read tick.budgetLimit only to surface the
                      // value in the tick message.
                      void tick.budgetLimit;
                      currentSectorId = tick.agent.sectorId;
                    }
                  } catch {
                    // Fall through to default tick message
                  }
                }

                sessionManager.addUserMessage(finalMessage);
                return runAgentLoop(sessionManager.getHistory(), {
                  config,
                  registry,
                  router,
                  costTracker,
                  tools,
                  sessionId: session.id,
                  projectPath,
                  systemPrompt,
                  systemSegments,
                  compaction: buildCompactionCallbacks(sessionManager),
                  permissionCheck: (name: string, perm: any) =>
                    permissionManager.check(name, perm),
                  preferredModelId,
                  middleware,
                  routingOutcomeRepo,
                  secretResolver: (name) => resolvedKeys.resolver.get(name),
                  onTurnComplete: (ctx: any) => {
                    ctx.turn = sessionManager.incrementTurn();
                    ctx.sessionMinutes = sessionManager.getSessionMinutes();
                    sessionManager.addTurnContext(ctx);

                    // Record sector tick completion
                    if (currentSectorId && sectorGraph && _recordSectorTick) {
                      try {
                        _recordSectorTick(
                          sectorGraph,
                          currentSectorId,
                          ctx.cost ?? 0,
                        );
                      } catch {
                        /* non-blocking */
                      }
                    }
                  },
                });
              },
              getDueTasks: () => triggerRunner.getDueTaskSummaries(),
              // ── Perception: what the daemon can see and reach. The first
              // tick renders this as the awakening inventory. ──
              getWorldState: () => {
                const connectors = [
                  ...(godModeResult?.connectedSystems.map((s) => ({
                    name: s.name,
                    healthy: true,
                    toolCount: s.toolCount,
                    domains: s.capabilities.slice(0, 6),
                  })) ?? []),
                  ...(godModeResult?.errors.map((e) => ({
                    name: e.name,
                    healthy: false,
                    toolCount: 0,
                  })) ?? []),
                ];
                const memoryCount = daemonMemory.listByTier("system").length;
                return {
                  connectors,
                  br: brStatus,
                  project: {
                    name: basename(projectPath),
                    onboarded: memoryCount > 0,
                    memoryCount,
                  },
                };
              },
              getOpenDrifts: () => collectOpenDrifts(),
              getPlatformEvents: () =>
                platformEventStore.listUnconsumed(10).map((e) => ({
                  id: e.id,
                  source: e.source,
                  eventType: e.eventType,
                  summary: e.summary,
                  receivedAt: e.receivedAt * 1000,
                })),
              onPlatformEventsConsumed: (ids) =>
                platformEventStore.markConsumed(ids.map(String)),
              // ── Self-awareness: router intelligence + BR cost pacing ──
              getRouterIntelligence: () => {
                const momentum = router.getMomentum();
                const recentFailureCount = router
                  .getRecentFailures()
                  .filter((f) => Date.now() - f.timestamp < 60_000).length;
                return {
                  momentum: momentum
                    ? {
                        modelId: momentum.modelId,
                        successCount: momentum.successCount,
                        taskType: momentum.taskType,
                      }
                    : null,
                  recentFailureCount,
                  convergenceAlerts: getConvergenceAlerts(3).map(
                    (a) => `${a.type} (${a.taskType}): ${a.detail}`,
                  ),
                };
              },
              getCostPacing: (defaultMs) =>
                costTracker.getAdvisedSleepMs(defaultMs),
              // ── Reflection: consolidate memory every N ticks ──
              reflectionInterval: config.daemon.reflectionIntervalTicks,
              onReflectionDue: async () => {
                const { runDreamCycle } = await import("@brainst0rm/core");
                await runDreamCycle({
                  memoryDir: daemonMemory.getMemoryDir(),
                  subagentOptions: {
                    config,
                    registry,
                    router,
                    costTracker,
                    tools,
                    projectPath,
                    permissionCheck: () => "allow",
                  } as any,
                });
              },
              // ── Approval gate: human checkpoint every N ticks (opt-in) ──
              approvalGateInterval: config.daemon.approvalGateIntervalTicks,
              onApprovalGate: async (gate) => {
                console.log(
                  `\n[gate] Tick ${gate.tickNumber} — $${gate.costSinceLastGate.toFixed(3)} since last gate ($${gate.totalCost.toFixed(3)} total)\n` +
                    `[gate] Tools used: ${gate.toolCallsSinceLastGate.slice(0, 12).join(", ") || "none"}`,
                );
                // Non-interactive daemon: log the gate and continue — budget
                // pacing and ChangeSet boundaries remain the hard controls.
                if (!gateQuestion) return true;
                const answer = await gateQuestion("[gate] Continue? [Y/n] ");
                return answer.trim().toLowerCase() !== "n";
              },
              getMemorySummary: () => {
                const system = daemonMemory.listByTier("system");
                if (system.length === 0)
                  return "No active memories. This project has not been onboarded. Consider running the onboard pipeline to build expertise before taking actions.";
                return system
                  .map((m: any) => `[${m.type}] ${m.name}: ${m.description}`)
                  .join("\n");
              },
              getAvailableSkills: () =>
                daemonSkills.map((s: any) => ({
                  name: s.name,
                  description: s.description.slice(0, 100),
                })),
              getLogSummary: () => {
                const recent = dailyLog.readRecent(10);
                if (recent.length === 0) return "No recent activity.";
                return recent
                  .map((e) => `[${e.eventType}] ${e.content.slice(0, 100)}`)
                  .join("\n");
              },
              onCheckpoint: async (state) => {
                sessRepo.updateDaemonState(session.id, {
                  tickCount: state.tickCount,
                  lastTickAt: Math.floor(Date.now() / 1000),
                  totalCost: state.totalCost,
                });
              },
              onTickComplete: async (result) => {
                dailyLog.append(
                  `${result.toolCalls.length} tools, model=${result.modelUsed}`,
                  {
                    tickNumber: result.tickNumber,
                    eventType: "tick",
                    cost: result.cost,
                    modelId: result.modelUsed,
                  },
                );
                sessRepo.updateDaemonState(session.id, {
                  tickCount: result.tickNumber,
                  lastTickAt: Math.floor(Date.now() / 1000),
                  totalCost: costTracker.getSessionCost(),
                });
              },
            });

            // Readline for user input preemption
            const readline = await import("node:readline/promises");
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            gateQuestion = (prompt: string) => rl.question(prompt);

            // Awakening banner — the daemon announces what it woke up knowing.
            console.log(
              `[kairos] Awake — ${godModeResult?.connectedSystems.length ?? 0} connectors (${godModeResult?.totalTools ?? 0} tools), BR ${brStatus.connected ? "connected" : "offline"}, ${daemonMemory.listByTier("system").length} memories; drift + platform-event feeds live.`,
            );

            // User input listener — preempts daemon sleep
            const inputLoop = (async () => {
              try {
                while (true) {
                  const line = await rl.question("");
                  if (!line.trim()) continue;
                  if (line.trim() === "/quit" || line.trim() === "/exit") {
                    daemon.stop();
                    break;
                  }
                  if (line.trim() === "/daemon pause") {
                    daemon.pause();
                    console.log("  [daemon paused]");
                    continue;
                  }
                  if (line.trim() === "/daemon resume") {
                    daemon.resume();
                    console.log("  [daemon resumed]");
                    continue;
                  }
                  if (line.trim() === "/daemon status") {
                    const s = daemon.getState();
                    console.log(
                      `  [daemon: ${s.status} | ticks: ${s.tickCount} | cost: $${s.totalCost.toFixed(4)}]`,
                    );
                    continue;
                  }
                  if (line.trim() === "/daemon log") {
                    const todayLog = dailyLog.readToday();
                    console.log(todayLog || "  [no daemon log entries today]");
                    continue;
                  }
                  // Regular user message — inject into daemon
                  daemon.injectUserMessage(line.trim());
                }
              } catch {
                // readline closed (Ctrl+D)
                daemon.stop();
              }
            })();

            // Ctrl+C stops daemon
            process.on("SIGINT", () => {
              daemon.stop();
              rl.close();
            });

            // Run daemon event loop
            for await (const event of daemon.run()) {
              switch (event.type) {
                case "daemon-tick":
                  process.stderr.write(
                    `  [tick #${(event as any).tickNumber} | $${(event as any).cost.toFixed(4)}]\n`,
                  );
                  break;
                case "daemon-sleep":
                  process.stderr.write(
                    `  [sleeping ${Math.round((event as any).sleepMs / 1000)}s: ${(event as any).reason}]\n`,
                  );
                  break;
                case "daemon-wake":
                  process.stderr.write(`  [wake: ${(event as any).trigger}]\n`);
                  break;
                case "daemon-stopped":
                  process.stderr.write(
                    `\n  [daemon stopped: ${(event as any).tickCount} ticks, $${(event as any).totalCost.toFixed(4)} total]\n`,
                  );
                  break;
                case "text-delta":
                  process.stdout.write(event.delta);
                  break;
                case "tool-call-start":
                  process.stdout.write(`\n  [tool: ${event.toolName}]\n`);
                  break;
                case "routing":
                  process.stderr.write(`\r  [${event.decision.model.name}]\n`);
                  break;
                case "done": {
                  const turnCost =
                    event.totalCost - costTracker.getSessionCost();
                  process.stdout.write(
                    `\n  [$${event.totalCost.toFixed(4)} session]\n`,
                  );
                  break;
                }
                case "error":
                  process.stderr.write(`\n  Error: ${event.error.message}\n`);
                  break;
              }
            }

            dailyLog.append("Daemon session ended", {
              eventType: "stop",
            });
            await inputLoop;
            rl.close();
            return;
          }

          let simpleAbortController: AbortController | null = null;

          // First Ctrl-C aborts current operation, second exits
          process.on("SIGINT", () => {
            if (simpleAbortController) {
              simpleAbortController.abort();
              simpleAbortController = null;
              process.stdout.write("\n  [interrupted]\n\n");
            } else {
              rl.close();
              process.exit(0);
            }
          });

          while (true) {
            const input = await rl.question("you > ");
            if (!input.trim()) continue;
            if (input.trim() === "/quit" || input.trim() === "/exit") break;

            // Handle slash commands in simple mode
            if (input.startsWith("/")) {
              const { isSlashCommand, executeSlashCommand } =
                await import("../commands/slash.js");
              if (isSlashCommand(input)) {
                const result = await executeSlashCommand(input, {
                  getModel: () => preferredModelId,
                  getSessionCost: () => costTracker.getSessionCost(),
                  getTokenCount: () => ({
                    input: 0,
                    output: 0,
                  }),
                  exit: () => {
                    rl.close();
                    process.exit(0);
                  },
                  clearHistory: () => {
                    session = sessionManager.start(projectPath);
                  },
                  setModel: (m) => {
                    preferredModelId = m;
                  },
                  setStrategy: (s) => {
                    router.setStrategy(s as any);
                  },
                  getStrategy: () => router.getActiveStrategy(),
                  setMode: (m) => {
                    permissionManager.setMode(m as any);
                  },
                  getMode: () => permissionManager.getMode(),
                  setOutputStyle: (s) => {
                    currentOutputStyle = s as any;
                    const rebuilt = buildSystemPrompt(
                      projectPath,
                      currentOutputStyle,
                    );
                    const ts = buildToolAwarenessSection(tools.listTools());
                    systemPrompt = rebuilt.prompt + ts;
                    // Rebuild segments with tool section in cacheable zone
                    systemSegments =
                      rebuilt.segments.length > 0
                        ? [
                            {
                              text: rebuilt.segments[0].text + ts,
                              cacheable: true,
                            },
                            ...rebuilt.segments.slice(1),
                          ]
                        : [{ text: systemPrompt, cacheable: true }];
                  },
                  getOutputStyle: () => currentOutputStyle,
                  getBudget: () => {
                    const remaining = costTracker.getRemainingBudget();
                    if (remaining === null) return null;
                    return {
                      remaining,
                      limit: config.budget.perSession ?? 0,
                    };
                  },
                  compact: async () => {
                    const result = await sessionManager.compact({
                      contextWindow: 200000,
                      keepRecent: 5,
                    });
                    console.log(
                      `  Compacted: ${result.removed} messages removed (${result.tokensBefore} → ${result.tokensAfter} tokens)`,
                    );
                  },
                });
                console.log(`  ${result}`);
                continue;
              }
              // Unknown slash command — pass to model as regular message
            }

            sessionManager.addUserMessage(input);
            let fullResponse = "";
            const sessionTotalBefore = costTracker.getSessionCost();
            process.stdout.write("\nbrainstorm > ");
            simpleAbortController = new AbortController();

            // Build role tool filter from active role (if any)
            const roleToolFilter =
              currentRole && ROLES[currentRole as RoleId]
                ? {
                    allowedTools: ROLES[currentRole as RoleId].allowedTools,
                    blockedTools: ROLES[currentRole as RoleId].blockedTools,
                  }
                : undefined;

            for await (const event of runAgentLoop(
              sessionManager.getHistory(),
              {
                config,
                registry,
                router,
                costTracker,
                tools,
                sessionId: session.id,
                projectPath,
                systemPrompt,
                systemSegments,
                compaction: buildCompactionCallbacks(sessionManager),
                signal: simpleAbortController.signal,
                permissionCheck: (name, perm) =>
                  permissionManager.check(name, perm),
                preferredModelId,
                middleware,
                roleToolFilter,
                routingOutcomeRepo,
                secretResolver: (name) => resolvedKeys.resolver.get(name),
                onTurnComplete: (ctx) => {
                  ctx.turn = sessionManager.incrementTurn();
                  ctx.sessionMinutes = sessionManager.getSessionMinutes();
                  sessionManager.addTurnContext(ctx);
                },
              },
            )) {
              switch (event.type) {
                case "thinking": {
                  const spinFrames = [
                    "⠋",
                    "⠙",
                    "⠹",
                    "⠸",
                    "⠼",
                    "⠴",
                    "⠦",
                    "⠧",
                    "⠇",
                    "⠏",
                  ];
                  const f =
                    spinFrames[
                      Math.floor(Date.now() / 100) % spinFrames.length
                    ];
                  const chatPhases: Record<string, string> = {
                    classifying: "Analyzing...",
                    routing: "Selecting model...",
                    connecting: "Connecting...",
                    streaming: "Streaming...",
                  };
                  process.stderr.write(
                    `\r  ${f} ${chatPhases[event.phase] ?? event.phase}`,
                  );
                  break;
                }
                case "routing":
                  process.stderr.write(`\r  [${event.decision.model.name}]\n`);
                  if (opts.verboseRouting) {
                    const d = event.decision;
                    process.stderr.write(
                      `  routing: strategy=${d.strategy} model=${d.model.id} provider=${d.model.provider} cost=$${d.estimatedCost.toFixed(4)} reason="${d.reason}"\n`,
                    );
                  }
                  break;
                case "text-delta":
                  fullResponse += event.delta;
                  process.stdout.write(event.delta);
                  break;
                case "tool-call-start":
                  process.stdout.write(`\n  [tool: ${event.toolName}]\n`);
                  break;
                case "tool-call-result":
                  break; // Tool results are shown by the model's text response
                case "model-retry":
                  process.stderr.write(
                    `\n  [retry: ${event.fromModel} → ${event.toModel}]\n`,
                  );
                  break;
                case "gateway-feedback": {
                  const gw = formatGatewayFeedback(event.feedback);
                  if (gw) process.stderr.write(`  ${gw}\n`);
                  break;
                }
                case "context-budget":
                  process.stderr.write(
                    `  [${Math.round(event.used / 1000)}k/${Math.round(event.limit / 1000)}k tokens (${event.percent}%)]\n`,
                  );
                  break;
                case "interrupted":
                  process.stdout.write("\n  [interrupted]\n\n");
                  break;
                case "done": {
                  const turn = sessionManager.getTurnCount();
                  const turnCost = event.totalCost - (sessionTotalBefore ?? 0);
                  sessionManager.syncSessionCost(turnCost);
                  process.stdout.write(
                    `\n  [Turn ${turn}: $${turnCost.toFixed(4)} | Session: $${event.totalCost.toFixed(4)}]\n\n`,
                  );
                  break;
                }
                case "error":
                  process.stderr.write(`\n  Error: ${event.error.message}\n\n`);
                  break;
              }
            }
            simpleAbortController = null;
            if (fullResponse) {
              sessionManager.addAssistantMessage(fullResponse);
              sessionManager.flush();
            }
          }
          rl.close();
          return;
        }

        // Ink TUI
        const { render } = await import("ink");
        const React = await import("react");
        const { App } = await import("../components/App.js");

        let currentAbortController: AbortController | null = null;

        function handleSendMessage(text: string) {
          sessionManager.addUserMessage(text);
          currentAbortController = new AbortController();
          // Build role tool filter from active role (if any)
          const roleFilter =
            currentRole && ROLES[currentRole as RoleId]
              ? {
                  allowedTools: ROLES[currentRole as RoleId].allowedTools,
                  blockedTools: ROLES[currentRole as RoleId].blockedTools,
                }
              : undefined;

          const gen = runAgentLoop(sessionManager.getHistory(), {
            config,
            registry,
            router,
            costTracker,
            tools,
            sessionId: session.id,
            projectPath,
            systemPrompt,
            systemSegments,
            compaction: buildCompactionCallbacks(sessionManager),
            signal: currentAbortController.signal,
            permissionCheck: (name, perm) =>
              permissionManager.check(name, perm),
            middleware,
            preferredModelId,
            roleToolFilter: roleFilter,
            routingOutcomeRepo,
            secretResolver: (name) => resolvedKeys.resolver.get(name),
          });
          // Wrap to capture assistant message after completion
          return (async function* () {
            let fullResponse = "";
            for await (const event of gen) {
              if (event.type === "text-delta") fullResponse += event.delta;
              yield event;
            }
            if (fullResponse) {
              sessionManager.addAssistantMessage(fullResponse);
              sessionManager.flush();
            }
            currentAbortController = null;
          })();
        }

        function handleAbort() {
          if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
          }
        }

        // Prepare model data for Models mode
        const modelData = registry.models.map((m: any) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          qualityTier: m.capabilities?.qualityTier ?? 3,
          speedTier: m.capabilities?.speedTier ?? 2,
          pricing: {
            input: m.pricing?.inputPer1MTokens ?? 0,
            output: m.pricing?.outputPer1MTokens ?? 0,
          },
          status: m.status ?? "available",
        }));

        const brGateway = createGatewayClient();

        // Phase 2: push-first coordination. When routingStream is opted-in
        // and a router API key is resolvable, open ONE SSE connection at the
        // boot layer and share it between (a) the dashboard panel and (b) the
        // learned-strategy observer. This way strategies learn from BR's
        // decisions regardless of which TUI mode is active.
        const routerApiKeyForStream = process.env.BRAINSTORM_ROUTER_API_KEY;
        let sharedRoutingStream: RoutingEventStream | undefined;
        if ((config.routing?.routingStream ?? false) && routerApiKeyForStream) {
          sharedRoutingStream = new RoutingEventStream({
            baseUrl:
              config.routing?.routingStreamUrl ??
              "https://api.brainstormrouter.com",
            apiKey: routerApiKeyForStream,
          });
          attachStreamToLearnedStrategy(sharedRoutingStream);
          sharedRoutingStream.start();
        }

        // Phase 3: peer coordination. Auto-spawn the local broker (no-op if
        // already running), register this session, start heartbeat + inbound
        // message poll. Tenant boundary is a fingerprint of the router API
        // key — sessions without a key skip peer coordination entirely. Never
        // throws; a broken broker does not take down the CLI.
        const { startPeerCoordination } =
          await import("../peer/peer-client.js");
        const activePeer = await startPeerCoordination({
          cwd: process.cwd(),
          summary: `storm chat in ${process.cwd().split("/").pop() ?? "workspace"}`,
          apiKey: routerApiKeyForStream,
        });
        if (activePeer) {
          const peerShutdown = () => {
            void activePeer.shutdown();
          };
          process.once("SIGINT", peerShutdown);
          process.once("SIGTERM", peerShutdown);
        }

        const inkInstance = render(
          React.createElement(App, {
            strategy: config.general.defaultStrategy,
            modelCount: { local: localCount, cloud: cloudCount },
            onSendMessage: handleSendMessage,
            onAbort: handleAbort,
            models: modelData,
            gateway: brGateway ?? undefined,
            configInfo: {
              strategy: config.general.defaultStrategy,
              permissionMode: config.general.defaultPermissionMode ?? "confirm",
              outputStyle: config.general.outputStyle ?? "concise",
              sandbox: config.shell?.sandbox ?? "none",
              sandboxPool: config.shell?.sandboxPool,
              channels: config.channels?.slack
                ? {
                    slack: {
                      enabled: config.channels.slack.enabled,
                      authority: config.channels.slack.authority,
                      mode: config.channels.slack.mode,
                    },
                  }
                : undefined,
            },
            vaultInfo: {
              exists: new BrainstormVault(VAULT_PATH).exists(),
              isOpen: false,
              keyCount: 0,
              keys: [],
              createdAt: null,
              opAvailable: !!process.env.OP_SERVICE_ACCOUNT_TOKEN,
              resolvedKeys: PROVIDER_KEY_NAMES.filter((k) =>
                resolvedKeys.get(k),
              ),
            },
            godModeInfo: godModeResult
              ? {
                  connectedSystems: godModeResult.connectedSystems,
                  errors: godModeResult.errors,
                  totalTools: godModeResult.totalTools,
                }
              : undefined,
            routingStreamEnabled: config.routing?.routingStream ?? false,
            routingStreamUrl: config.routing?.routingStreamUrl,
            routingStream: sharedRoutingStream,
            memoryInfo: await (async () => {
              try {
                const { MemoryManager } = await import("@brainst0rm/core");
                const mem = new MemoryManager(projectPath);
                const entries = mem.list();
                const types: Record<string, number> = {};
                for (const e of entries) {
                  types[e.type] = (types[e.type] ?? 0) + 1;
                }
                return { localCount: entries.length, types };
              } catch {
                return { localCount: 0, types: {} };
              }
            })(),
            slashCallbacks: {
              setModel: (model: string) => {
                preferredModelId = model;
              },
              setStrategy: (s: string) => {
                router.setStrategy(s as any);
              },
              getStrategy: () => router.getActiveStrategy(),
              setMode: (mode: string) => {
                permissionManager.setMode(mode as any);
              },
              getMode: () => permissionManager.getMode(),
              setOutputStyle: (style: string) => {
                currentOutputStyle = style as OutputStyle;
                const rebuilt = buildSystemPrompt(
                  projectPath,
                  currentOutputStyle,
                );
                const ts = buildToolAwarenessSection(tools.listTools());
                systemPrompt = rebuilt.prompt + ts;
                systemSegments =
                  rebuilt.segments.length > 0
                    ? [
                        {
                          text: rebuilt.segments[0].text + ts,
                          cacheable: true,
                        },
                        ...rebuilt.segments.slice(1),
                      ]
                    : [{ text: systemPrompt, cacheable: true }];
              },
              getOutputStyle: () => currentOutputStyle,
              rebuildSystemPrompt: (basePromptOverride?: string) => {
                const rebuilt = buildSystemPrompt(
                  projectPath,
                  currentOutputStyle,
                  basePromptOverride,
                );
                const ts = buildToolAwarenessSection(tools.listTools());
                systemPrompt = rebuilt.prompt + ts;
                systemSegments =
                  rebuilt.segments.length > 0
                    ? [
                        {
                          text: rebuilt.segments[0].text + ts,
                          cacheable: true,
                        },
                        ...rebuilt.segments.slice(1),
                      ]
                    : [{ text: systemPrompt, cacheable: true }];
              },
              getActiveRole: () => currentRole,
              setActiveRole: (role: string | undefined) => {
                currentRole = role;
              },
              getBudget: () => {
                const state = costTracker.getBudgetState();
                if (!state.sessionLimit) return null;
                return {
                  remaining: Math.max(
                    0,
                    state.sessionLimit - state.sessionUsed,
                  ),
                  limit: state.sessionLimit,
                };
              },
              compact: async () => {
                // Use the current model's context window, or fall back to 128k
                const models = router.getModels();
                const activeModel = preferredModelId
                  ? models.find((m) => m.id === preferredModelId)
                  : models[0];
                const contextWindow =
                  activeModel?.limits?.contextWindow || 128_000;
                const cb = buildCompactionCallbacks(sessionManager);
                await cb.compact({ contextWindow });
              },
              dream: async () => {
                const { MemoryManager, DREAM_SYSTEM_PROMPT, buildDreamPrompt } =
                  await import("@brainst0rm/core");
                const memory = new MemoryManager(projectPath);
                const rawFiles = memory.getRawFiles();
                if (rawFiles.length === 0)
                  return "No memory files to consolidate.";
                const dreamPrompt = buildDreamPrompt(
                  memory.getMemoryDir(),
                  rawFiles,
                );
                const result = await spawnSubagent(dreamPrompt, {
                  config,
                  registry,
                  router,
                  costTracker,
                  tools,
                  projectPath,
                  type: "code",
                  systemPrompt: DREAM_SYSTEM_PROMPT,
                  maxSteps: 12,
                  budgetLimit: 0.5,
                });
                return `Dream complete. ${result.toolCalls.length} tool calls, $${result.cost.toFixed(4)}.\n${result.text}`;
              },
              vault: async (action: string, args: string) => {
                const vault = new BrainstormVault(VAULT_PATH);
                switch (action) {
                  case "list":
                  case "ls": {
                    if (!vault.exists())
                      return "No vault found. Run `brainstorm vault init` to create one.";
                    const keys = vault.list();
                    if (keys.length === 0)
                      return "Vault is empty (or locked). Keys: none";
                    return `Vault keys (${keys.length}):\n${keys.map((k) => `  - ${k}`).join("\n")}`;
                  }
                  case "status": {
                    if (!vault.exists()) return "Vault: not initialized";
                    return `Vault: ${VAULT_PATH}\nStatus: ${vault.isOpen() ? "unlocked" : "locked"}\nKeys: ${vault.list().length}`;
                  }
                  case "get": {
                    const tokens = args.trim().split(/\s+/);
                    const keyName = tokens[0];
                    const reveal = tokens.includes("--reveal");
                    if (!keyName)
                      return "Usage: /vault get <key-name> [--reveal]";
                    const val = vault.get(keyName);
                    if (val === null)
                      return `Key '${keyName}' not found (or vault is locked).`;
                    return `${keyName} = ${reveal ? val : maskSecret(val)}`;
                  }
                  case "add":
                  case "set": {
                    return "Use `brainstorm vault add <name>` from the terminal — requires interactive password input.";
                  }
                  case "remove":
                  case "rm":
                  case "delete": {
                    return "Use `brainstorm vault remove <name>` from the terminal — requires interactive password input.";
                  }
                  default:
                    return "Usage: /vault [list|status|get <name>]\nFor add/remove, use the `brainstorm vault` CLI command.";
                }
              },
            },
          }),
        );

        // LLM memory extraction at session teardown. Without an explicit
        // process.exit() this path exits by event-loop drain, and the
        // extraction subagent's pending network I/O would otherwise keep
        // the process alive until it settles — so await with a hard cap
        // and then force exit to preserve prior quit behavior (immediate
        // terminal return).
        inkInstance.waitUntilExit().then(async () => {
          await runMemoryExtractionTeardown({
            projectPath,
            sessionManager,
            config,
            registry,
            router,
            costTracker,
            tools,
            // Shorter cap than the one-shot `run` path: this holds the
            // user's terminal at quit, so give extraction a brief window
            // rather than a full LLM-call budget.
            hardTimeoutMs: 5_000,
          });
          process.exit(0);
        });
      },
    );
}
