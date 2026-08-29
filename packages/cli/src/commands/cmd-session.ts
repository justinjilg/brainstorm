/**
 * `brainstorm` session commands — extracted from the former bin/brainstorm.ts
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
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import {
  createDefaultToolRegistry,
  createWiredMemoryTool,
  createWiredCodeGraphTools,
  configureSandbox,
} from "@brainst0rm/tools";
import {
  runAgentLoop,
  buildSystemPrompt,
  buildToolAwarenessSection,
  SessionManager,
  PermissionManager,
  createDefaultMiddlewarePipeline,
  type SystemPromptSegment,
} from "@brainst0rm/core";
import { renderMarkdownToString } from "../components/MarkdownRenderer.js";
import { runProbe } from "@brainst0rm/eval";
import { formatGatewayFeedback } from "@brainst0rm/gateway";
import { KeyResolver } from "@brainst0rm/vault";
import { join } from "node:path";
import {
  ResolvedKeysWithResolver,
  resolveProviderKeys,
  buildCompactionCallbacks,
  connectMCPServers,
  runMemoryExtractionTeardown,
} from "./_context.js";

export function registerSessionCommands(program: Command): void {
  program
    .command("run")
    .description("Run a single prompt non-interactively")
    .argument("[prompt]", "The prompt to send")
    .option("--pipe", "Read from stdin if no prompt given")
    .option("--model <id>", "Target a specific model (bypass routing)")
    .option("--tools", "Enable tool use (default: disabled)")
    .option("--max-steps <n>", "Maximum agentic steps (default: 1)", "1")
    .option(
      "--strategy <name>",
      "Routing strategy: cost-first, quality-first, combined, capability",
    )
    .option("--json", "Output final result as structured JSON")
    .option("--events", "Stream every AgentEvent as timestamped JSONL")
    .option("--lfg", "Full auto mode — skip all permission confirmations")
    .option(
      "--unattended",
      "Unattended mode — enable tools, auto-approve, auto-commit on success",
    )
    .action(
      async (
        prompt: string | undefined,
        opts: {
          pipe?: boolean;
          model?: string;
          tools?: boolean;
          maxSteps?: string;
          strategy?: string;
          json?: boolean;
          events?: boolean;
          lfg?: boolean;
          unattended?: boolean;
        },
      ) => {
        // Handle --pipe: read prompt from stdin
        let finalPrompt = prompt;
        if (opts.pipe) {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          const stdinText = Buffer.concat(chunks).toString("utf-8").trim();
          if (finalPrompt) {
            // Append stdin to prompt argument
            finalPrompt = `${finalPrompt}\n\n${stdinText}`;
          } else {
            finalPrompt = stdinText;
          }
        }
        if (!finalPrompt) {
          process.stderr.write(
            "Error: No prompt provided. Pass a prompt argument or use --pipe to read from stdin.\n",
          );
          process.exit(1);
        }

        const config = loadConfig();

        // --lfg / --unattended: full auto mode, skip all permission confirmations
        if (opts.lfg || opts.unattended) {
          config.general.defaultPermissionMode = "auto";
        }
        // --unattended: enable tools and higher step count by default
        if (opts.unattended) {
          opts.tools = true;
          if (!opts.maxSteps || opts.maxSteps === "1") opts.maxSteps = "15";
        }

        // Output mode: explicit flags override, human-readable by default
        const machineMode = opts.json || opts.events;
        // Can we prompt for input? Only if stdin is a TTY.
        const canPrompt = process.stdin.isTTY ?? false;

        const db = getDb();
        // Skip vault prompt when non-interactive (no TTY on stdin) or explicit machine mode
        const resolvedKeys: ResolvedKeysWithResolver =
          canPrompt && !machineMode
            ? await resolveProviderKeys()
            : {
                get: (name: string) => process.env[name] ?? null,
                resolve: async (name: string) => process.env[name] ?? null,
                resolver: new KeyResolver(null),
              };
        const resolvedBRKey =
          resolvedKeys.get("BRAINSTORM_API_KEY") ?? getBrainstormApiKey();
        const isCommunityTier = isCommunityKey(resolvedBRKey);
        // Set env for native BR tools (br_status, br_budget, etc.)
        if (resolvedBRKey) process.env._BR_RESOLVED_KEY = resolvedBRKey;
        const registry = await createProviderRegistry(config, resolvedKeys);
        const costTracker = new CostTracker(db, config.budget);
        const tools = createDefaultToolRegistry();
        const runProjectPath = process.cwd();

        // Wire memory tool for run command
        {
          const { MemoryManager: RunMemoryManager } =
            await import("@brainst0rm/core");
          const runMemory = new RunMemoryManager(runProjectPath);
          const wiredRunMemory = createWiredMemoryTool(runMemory);
          tools.unregister("memory");
          tools.register(wiredRunMemory);
        }

        // Wire code graph tools for run command
        try {
          const { CodeGraph } = await import("@brainst0rm/code-graph");
          const codeGraph = new CodeGraph({ projectPath: runProjectPath });
          const wiredCodeGraphTools = createWiredCodeGraphTools(codeGraph);
          for (const tool of wiredCodeGraphTools) {
            tools.unregister(tool.name);
            tools.register(tool);
          }
        } catch (e) {
          // code-graph package may not be built — tools stay as stubs
        }

        await connectMCPServers(
          tools,
          config,
          resolvedKeys.get("BRAINSTORM_API_KEY"),
        );
        const sessionManager = new SessionManager(db);
        const projectPath = runProjectPath;
        configureSandbox(
          config.shell.sandbox,
          projectPath,
          config.shell.maxOutputBytes,
          config.shell.containerImage,
          config.shell.containerTimeout,
          config.shell.sandboxPool,
        );
        // Complexity-aware prompt tiering: the `run` command is single-shot, so
        // varying the cached prefix by complexity here is cache-safe (no cross-turn
        // cache to defeat). A trivial prompt ("hi") ships the lean prefix instead
        // of the full ~12K context.
        let runComplexity: import("@brainst0rm/shared").Complexity | undefined;
        try {
          const { classifyTask } = await import("@brainst0rm/router");
          runComplexity = classifyTask(finalPrompt).complexity;
        } catch {
          runComplexity = undefined; // fall back to full prefix on any failure
        }
        const {
          prompt: rawPrompt,
          segments: rawSegments,
          frontmatter,
        } = buildSystemPrompt(
          projectPath,
          undefined,
          undefined,
          runComplexity,
          {
            taskText: finalPrompt,
          },
        );
        const toolSection = buildToolAwarenessSection(tools.listTools());
        const systemPrompt = rawPrompt + toolSection;
        const systemSegments: SystemPromptSegment[] =
          rawSegments.length > 0
            ? [
                { text: rawSegments[0].text + toolSection, cacheable: true },
                ...rawSegments.slice(1),
              ]
            : [{ text: systemPrompt, cacheable: true }];
        const routingOutcomeRepo = new RoutingOutcomeRepository(db);
        const router = new BrainstormRouter(
          config,
          registry,
          costTracker,
          frontmatter,
          routingOutcomeRepo.loadAggregated(),
        );

        // Permission manager — gates tool execution
        const permissionManager = new PermissionManager(
          config.general.defaultPermissionMode,
          config.permissions,
        );

        // Strategy: CLI flag → paid/direct-key default → config default
        const hasDirectKeys =
          !!resolvedKeys.get("DEEPSEEK_API_KEY") ||
          !!resolvedKeys.get("ANTHROPIC_API_KEY") ||
          !!resolvedKeys.get("OPENAI_API_KEY") ||
          !!resolvedKeys.get("GOOGLE_GENERATIVE_AI_API_KEY") ||
          !!resolvedKeys.get("MOONSHOT_API_KEY");
        if (opts.strategy) {
          router.setStrategy(opts.strategy as StrategyName);
        }
        // Otherwise: respect config.general.defaultStrategy (set by router constructor).
        // Previously this code force-overrode to quality-first when the user had their
        // own API keys. That defeated cost-aware routing — every task routed to the
        // single highest-quality model, starving the learning loop and ignoring the
        // task classifier. The "combined" default already escalates complex/expert
        // tasks to quality-first internally; simple/moderate tasks should benefit
        // from cost-first or weighted scoring.

        // God Mode: connect if any connector key is present
        const runHasConnectorKey = !!(
          process.env.BRAINSTORM_MSP_API_KEY ||
          process.env.BRAINSTORM_EMAIL_API_KEY ||
          process.env.BRAINSTORM_VM_API_KEY ||
          process.env._GM_MSP_KEY ||
          process.env._GM_EMAIL_KEY ||
          process.env._GM_VM_KEY ||
          process.env._GM_AGENT_KEY
        );
        if (runHasConnectorKey || config.godmode.enabled) {
          try {
            const {
              connectGodMode: connectGM,
              createProductConnectors: createPC,
              setAuditPersister: setAP,
            } = await import("@brainst0rm/godmode");
            const { ChangeSetLogRepository: CSLogRun } =
              await import("@brainst0rm/db");

            const csLogRun = new CSLogRun(db);
            setAP((entry) => {
              csLogRun.log({
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

            const mspBaseUrl =
              process.env.BRAINSTORM_MSP_URL ?? "https://brainstormmsp.ai";
            const defaultConns: Record<string, any> = {
              msp: {
                enabled: true,
                baseUrl: mspBaseUrl,
                apiKeyName: "BRAINSTORM_MSP_API_KEY",
              },
            };
            const mergedConfig = {
              ...config.godmode,
              connectors: { ...defaultConns, ...config.godmode.connectors },
            };
            const activeConns = await createPC(mergedConfig);

            // Add typed agent connector (routes through MSP's agent management API)
            const { createAgentConnector } =
              await import("@brainst0rm/godmode/connectors/agent");
            activeConns.push(
              createAgentConnector({
                enabled: true,
                baseUrl: mspBaseUrl,
                apiKeyName: "_GM_AGENT_KEY",
              }),
            );

            const gmResult = await connectGM(tools, mergedConfig, activeConns);

            if (gmResult.connectedSystems.length > 0) {
              // Rebuild tool awareness and system prompt with God Mode tools
              const gmToolSection = buildToolAwarenessSection(
                tools.listTools(),
              );
              systemSegments[0] = {
                text:
                  rawSegments[0]?.text +
                  gmToolSection +
                  "\n" +
                  (gmResult.promptSegment?.text ?? ""),
                cacheable: true,
              };
              process.stderr.write(
                `[godmode] Connected: ${gmResult.connectedSystems.map((s) => s.displayName).join(", ")} (${gmResult.totalTools} tools)\n`,
              );
            }
          } catch (err) {
            process.stderr.write(
              `[godmode] ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }

        const session = sessionManager.start(projectPath);

        sessionManager.addUserMessage(finalPrompt);

        let fullResponse = "";
        let modelName = "unknown";
        let toolCallCount = 0;

        if (!machineMode) {
          process.stdout.write("\n");
        }

        const middleware = createDefaultMiddlewarePipeline(projectPath);
        for await (const event of runAgentLoop(sessionManager.getHistory(), {
          config,
          registry,
          router,
          costTracker,
          tools,
          sessionId: session.id,
          projectPath,
          systemPrompt,
          systemSegments,
          disableTools: !opts.tools,
          // Model selection: honor --model flag, otherwise let the router decide.
          // Community-tier users without their own keys fall through to the hosted
          // brainstormrouter/auto endpoint. Everyone else goes through the router,
          // which respects config.general.defaultStrategy (combined by default,
          // auto-upgraded to capability when eval data is available).
          preferredModelId:
            opts.model ??
            (isCommunityTier &&
            !resolvedKeys.get("DEEPSEEK_API_KEY") &&
            !resolvedKeys.get("ANTHROPIC_API_KEY") &&
            !resolvedKeys.get("OPENAI_API_KEY") &&
            !resolvedKeys.get("GOOGLE_GENERATIVE_AI_API_KEY") &&
            !resolvedKeys.get("MOONSHOT_API_KEY")
              ? "brainstormrouter/auto"
              : undefined),
          maxSteps: parseInt(opts.maxSteps ?? "1"),
          compaction: buildCompactionCallbacks(sessionManager),
          permissionCheck: (tool, args) => permissionManager.check(tool, args),
          middleware,
          routingOutcomeRepo,
          secretResolver: (name) => resolvedKeys.resolver.get(name),
        })) {
          // --events: every event as timestamped JSONL
          if (opts.events) {
            process.stdout.write(
              JSON.stringify({ ts: Date.now(), ...event }) + "\n",
            );
          }

          // Track state regardless of output mode
          switch (event.type) {
            case "routing":
              modelName = event.decision.model.name;
              break;
            case "text-delta":
              fullResponse += event.delta;
              break;
            case "tool-call-start":
              toolCallCount++;
              break;
            case "model-retry":
              modelName = event.toModel;
              fullResponse = "";
              break;
          }

          // --json: emit final result only (on done/error)
          if (opts.json) {
            if (event.type === "done") {
              process.stdout.write(
                JSON.stringify({
                  text: fullResponse,
                  model: modelName,
                  cost: event.totalCost,
                  toolCalls: toolCallCount,
                  success: true,
                }) + "\n",
              );
            } else if (event.type === "error") {
              process.stdout.write(
                JSON.stringify({
                  text: "",
                  model: modelName,
                  cost: 0,
                  toolCalls: toolCallCount,
                  error: event.error.message,
                  success: false,
                }) + "\n",
              );
              process.exit(1);
            }
          }

          // Default: human rendering
          if (!machineMode) {
            switch (event.type) {
              case "thinking": {
                const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
                const f = frames[Math.floor(Date.now() / 100) % frames.length];
                const labels: Record<string, string> = {
                  classifying: "Classifying task...",
                  routing: "Selecting model...",
                  connecting: "Connecting...",
                  streaming: "Streaming...",
                };
                process.stderr.write(
                  `\r${f} ${labels[event.phase] ?? event.phase}`,
                );
                break;
              }
              case "routing":
                process.stderr.write(
                  `\r[${event.decision.strategy}] → ${modelName}\n`,
                );
                break;
              case "tool-call-start":
                process.stderr.write(`\n[tool: ${event.toolName}]\n`);
                break;
              case "tool-call-result":
                process.stderr.write(`[done]\n`);
                break;
              case "gateway-feedback": {
                const gwLine = formatGatewayFeedback(event.feedback);
                if (gwLine) process.stderr.write(`${gwLine}\n`);
                break;
              }
              case "model-retry":
                process.stderr.write(
                  `\n[retry] ${event.fromModel} → ${event.toModel} (${event.reason})\n`,
                );
                break;
              case "done":
                process.stdout.write(renderMarkdownToString(fullResponse));
                process.stdout.write(
                  `\n\n[cost: $${event.totalCost.toFixed(4)}]\n`,
                );
                break;
              case "error":
                process.stderr.write(`\nError: ${event.error.message}\n`);
                break;
            }
          }
        }

        if (fullResponse) {
          sessionManager.addAssistantMessage(fullResponse);
          sessionManager.flush();
        }

        // Fire-and-forget LLM memory extraction; this command's process exits
        // right after the action resolves, so await with a hard cap.
        await runMemoryExtractionTeardown({
          projectPath,
          sessionManager,
          config,
          registry,
          router,
          costTracker,
          tools,
          hardTimeoutMs: 15_000,
        });
      },
    );

  // ── Probe Command ─────────────────────────────────────────────────

  program
    .command("probe")
    .description(
      "Run an ad-hoc eval probe with verification (for autonomous testing)",
    )
    .argument("<prompt>", "The prompt to test")
    .option("--model <id>", "Target a specific model")
    .option(
      "--expect-tools <tools>",
      "Comma-separated tool names that must be called",
    )
    .option(
      "--expect-contains <strings>",
      "Comma-separated strings that must appear in output",
    )
    .option(
      "--expect-excludes <strings>",
      "Comma-separated strings that must NOT appear",
    )
    .option("--min-steps <n>", "Minimum number of agentic steps")
    .option("--max-steps <n>", "Maximum number of agentic steps", "10")
    .option("--timeout <ms>", "Timeout in milliseconds", "30000")
    .option("--json", "Output full ProbeResult as JSON")
    .option("--setup-file <pairs...>", "Setup files as path=content pairs")
    .action(async (prompt: string, opts: any) => {
      // Build Probe from CLI args
      const probe: any = {
        id: `adhoc-${Date.now().toString(36)}`,
        capability: "multi-step" as const,
        prompt,
        verify: {},
        timeout_ms: parseInt(opts.timeout),
      };

      if (opts.expectTools) {
        probe.verify.tool_calls_include = opts.expectTools
          .split(",")
          .map((s: string) => s.trim());
      }
      if (opts.expectContains) {
        probe.verify.answer_contains = opts.expectContains
          .split(",")
          .map((s: string) => s.trim());
      }
      if (opts.expectExcludes) {
        probe.verify.answer_excludes = opts.expectExcludes
          .split(",")
          .map((s: string) => s.trim());
      }
      if (opts.minSteps) {
        probe.verify.min_steps = parseInt(opts.minSteps);
      }
      if (opts.maxSteps) {
        probe.verify.max_steps = parseInt(opts.maxSteps);
      }

      // Parse setup files: --setup-file "path=content" --setup-file "path2=content2"
      if (opts.setupFile) {
        probe.setup = { files: {} as Record<string, string> };
        for (const pair of opts.setupFile) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx > 0) {
            probe.setup.files[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
          }
        }
      }

      const result = await runProbe(probe, {
        modelId: opts.model,
        maxSteps: parseInt(opts.maxSteps),
        defaultTimeout: parseInt(opts.timeout),
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        const status = result.passed ? "PASSED" : "FAILED";
        console.log(`\n  Probe: ${status}`);
        console.log(`  Model: ${result.modelId}`);
        console.log(`  Steps: ${result.steps}`);
        console.log(`  Cost:  $${result.cost.toFixed(4)}`);
        console.log(`  Time:  ${result.durationMs}ms`);
        if (result.toolCalls.length > 0) {
          console.log(
            `  Tools: ${result.toolCalls.map((t) => t.name).join(", ")}`,
          );
        }
        if (!result.passed) {
          const failures = result.checks.filter((c) => !c.passed);
          console.log(`  Failures:`);
          for (const f of failures) {
            console.log(`    - ${f.check}: ${f.detail ?? "failed"}`);
          }
        }
        if (result.error) console.log(`  Error: ${result.error}`);
        console.log(
          `  Output: ${result.output.slice(0, 200)}${result.output.length > 200 ? "..." : ""}`,
        );
        console.log();
      }

      process.exit(result.passed ? 0 : 1);
    });
}
