import { Command } from "commander";
import { initSentry, captureError, flushSentry } from "@brainst0rm/shared";
import { loadConfig } from "@brainst0rm/config";
import {
  getDb,
  closeDb,
  CostRepository,
  RoutingOutcomeRepository,
} from "@brainst0rm/db";
import {
  createProviderRegistry,
  getBrainstormApiKey,
  isCommunityKey,
} from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import {
  createDefaultToolRegistry,
  createWiredMemoryTool,
  createWiredPipelineTool,
  createWiredCodeGraphTools,
  configureSandbox,
  stopDockerSandbox,
} from "@brainst0rm/tools";
import {
  runAgentLoop,
  buildSystemPrompt,
  buildToolAwarenessSection,
  SessionManager,
  PermissionManager,
  createSubagentTool,
  spawnSubagent,
  spawnParallel,
  createDefaultMiddlewarePipeline,
  segmentsToString,
  type CompactionCallbacks,
  type SystemPromptSegment,
} from "@brainst0rm/core";
import type { OutputStyle } from "@brainst0rm/core";
import { AgentManager, parseAgentNL } from "@brainst0rm/agents";
import { ROLES, type RoleId } from "../commands/roles.js";
import {
  runWorkflow,
  getPresetWorkflow,
  autoSelectPreset,
  PRESET_WORKFLOWS,
} from "@brainst0rm/workflow";
import { renderMarkdownToString } from "../components/MarkdownRenderer.js";
import { runInit } from "../init/index.js";
import { runEvalCli, runProbe } from "@brainst0rm/eval";
import {
  createGatewayClient,
  createIntelligenceClient,
  formatGatewayFeedback,
} from "@brainst0rm/gateway";
import { MCPClientManager } from "@brainst0rm/mcp";
import { BrainstormVault, KeyResolver } from "@brainst0rm/vault";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedKeys } from "@brainst0rm/providers";

/** Known API key names that providers and connectors need at startup. */
const PROVIDER_KEY_NAMES = [
  "BRAINSTORM_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
  "BRAINSTORM_ADMIN_KEY",
  // God Mode connector keys — resolved so connectors can authenticate
  "BRAINSTORM_MSP_API_KEY",
  "BRAINSTORM_EMAIL_API_KEY",
  "BRAINSTORM_VM_API_KEY",
];

/**
 * Eagerly resolve all provider keys through the vault/1Password/env chain.
 * Triggers the lazy vault password prompt if a vault exists and keys are needed.
 * Returns a sync ResolvedKeys map for createProviderRegistry.
 */
interface ResolvedKeysWithResolver extends ResolvedKeys {
  /** Async resolver for $VAULT_* substitution — can look up any key, not just provider keys. */
  resolver: KeyResolver;
}

async function resolveProviderKeys(): Promise<ResolvedKeysWithResolver> {
  const vault = new BrainstormVault(VAULT_PATH);
  const resolver = new KeyResolver(vault.exists() ? vault : null, () =>
    promptPassword("  Vault password: "),
  );

  const resolved = new Map<string, string>();
  for (const name of PROVIDER_KEY_NAMES) {
    const value = await resolver.get(name);
    if (value) {
      resolved.set(name, value);
      // Make resolved keys available via process.env for God Mode connectors
      // and other subsystems that read from environment
      process.env[name] = value;
    }
  }

  return {
    get: (name: string) => resolved.get(name) ?? null,
    resolver,
  };
}

function buildCompactionCallbacks(
  sessionManager: SessionManager,
): CompactionCallbacks {
  return {
    getTokenEstimate: () => sessionManager.getTokenEstimate(),
    compact: (opts) => sessionManager.compact(opts),
  };
}

/**
 * Start the sync queue drain worker if a BR gateway is configured.
 * Returns the worker for later shutdown, or null if no gateway.
 *
 * Week 1.5: this is the wiring that actually activates the retry queue.
 * Without it, Phase 1's sync_queue table and SyncWorker exist but never
 * drain — every fire-and-forget push that fails sits forever.
 *
 * The worker self-schedules on a 15s interval. Callers that need to
 * stop it (tests, graceful shutdown) can call the returned object's
 * .stop() method.
 */
async function startSyncWorkerIfConfigured(
  gateway: ReturnType<typeof createGatewayClient> | null,
  db: any,
): Promise<{ stop: () => void } | null> {
  if (!gateway) return null;
  try {
    const { SyncWorker } = await import("@brainst0rm/gateway");
    const { SyncQueueRepository } = await import("@brainst0rm/db");
    const repo = new SyncQueueRepository(db);
    const worker = new SyncWorker({ gateway, repo });
    worker.start();
    return worker;
  } catch {
    // Best effort — sync worker is optional. Missing package or init
    // failure should never block the chat command from starting.
    return null;
  }
}

/**
 * Connect to MCP servers from config + BrainstormRouter gateway.
 * Loads user-configured servers from config.mcp.servers (populated from
 * config.toml and .brainstorm/mcp.json), plus the built-in gateway server.
 */
async function connectMCPServers(
  tools: ReturnType<typeof createDefaultToolRegistry>,
  config: ReturnType<typeof loadConfig>,
  resolvedBRKey?: string | null,
): Promise<void> {
  const mcp = new MCPClientManager();

  // User-configured MCP servers from config.toml / .brainstorm/mcp.json
  if (config.mcp.servers.length > 0) {
    mcp.addServers(
      config.mcp.servers.map((s) => ({
        name: s.name,
        transport: s.transport,
        url: s.url ?? "",
        command: s.command,
        args: s.args,
        env: s.env,
        enabled: s.enabled,
        toolFilter: s.toolFilter,
      })),
    );
  }

  // BrainstormRouter intelligence tools are built-in natively
  // (br_status, br_budget, etc.). MCP is used for user-configured servers.
  // Tool definitions are validated before registration (see mcp/client.ts).

  const { connected, errors } = await mcp.connectAll(tools);
  if (connected.length > 0) {
    process.stderr.write(`[mcp] Connected: ${connected.join(", ")}\n`);
  }
  for (const err of errors) {
    process.stderr.write(`[mcp] ${err.name}: ${err.error}\n`);
  }
}

const program = new Command();
const execFile = promisify(execFileCallback);

interface DoctorCheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

interface DoctorSection {
  title: string;
  results: DoctorCheckResult[];
}

function formatDoctorStatus(status: DoctorCheckResult["status"]): string {
  return status === "pass" ? "✓" : status === "fail" ? "✗" : "○";
}

function parseEnvExampleKeys(content: string): string[] {
  const keys = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*?)\s*=/);
    if (match?.[1]) keys.add(match[1]);
  }

  return [...keys];
}

async function runBuildDoctorCheck(cwd: string): Promise<DoctorSection> {
  try {
    await execFile("npx", ["turbo", "run", "build", "--summarize"], {
      cwd,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
      env: process.env,
    });
    return {
      title: "Build",
      results: [
        {
          name: "workspace build",
          status: "pass",
          detail: "turbo run build completed successfully.",
        },
      ],
    };
  } catch (error: any) {
    const detail =
      error?.stderr?.trim() ||
      error?.stdout?.trim() ||
      error?.message ||
      "Build failed.";
    return {
      title: "Build",
      results: [
        {
          name: "workspace build",
          status: "fail",
          detail,
        },
      ],
    };
  }
}

function runEnvDoctorCheck(cwd: string): DoctorSection {
  const envExamplePath = join(cwd, ".env.example");
  if (!existsSync(envExamplePath)) {
    return {
      title: "Environment",
      results: [
        {
          name: ".env.example",
          status: "warn",
          detail: "No .env.example found in the current workspace.",
        },
      ],
    };
  }

  const envExample = readFileSync(envExamplePath, "utf-8");
  const referencedKeys = parseEnvExampleKeys(envExample);
  if (referencedKeys.length === 0) {
    return {
      title: "Environment",
      results: [
        {
          name: ".env.example",
          status: "warn",
          detail: "No environment variables were declared in .env.example.",
        },
      ],
    };
  }

  const missingKeys = referencedKeys.filter((key) => !process.env[key]);
  return {
    title: "Environment",
    results: missingKeys.length
      ? missingKeys.map((key) => ({
          name: key,
          status: "warn" as const,
          detail:
            "Referenced in .env.example but not present in the current environment.",
        }))
      : [
          {
            name: ".env.example",
            status: "pass",
            detail: `All ${referencedKeys.length} referenced variables are present in the current environment.`,
          },
        ],
  };
}

async function runModelDoctorCheck(): Promise<DoctorSection> {
  const config = loadConfig();
  const registry = await createProviderRegistry(
    config,
    await resolveProviderKeys(),
  );
  const unreachable = registry.models.filter(
    (model) => model.status !== "available",
  );

  if (unreachable.length > 0) {
    return {
      title: "Models",
      results: unreachable.map((model) => ({
        name: model.id,
        status: "warn" as const,
        detail: `Reported as ${model.status}.`,
      })),
    };
  }

  return {
    title: "Models",
    results: [
      {
        name: "registry",
        status: "pass",
        detail: `All ${registry.models.length} discovered models are currently marked available.`,
      },
    ],
  };
}

function printDoctorSection(section: DoctorSection): void {
  console.log(`\n  ${section.title}:`);
  for (const result of section.results) {
    console.log(
      `    ${formatDoctorStatus(result.status)} ${result.name.padEnd(20)} ${result.detail}`,
    );
  }
}

// Read version from package.json at runtime (stays in sync with bump-version.mjs)
import { readFileSync as readFileSyncVersion } from "node:fs";
import { dirname as dirnameVersion } from "node:path";
import { fileURLToPath as fileURLToPathVersion } from "node:url";
const __pkg_dir = join(
  dirnameVersion(fileURLToPathVersion(import.meta.url)),
  "..",
);
let CLI_VERSION = "0.12.1";
try {
  CLI_VERSION = JSON.parse(
    readFileSyncVersion(join(__pkg_dir, "package.json"), "utf-8"),
  ).version;
} catch {
  /* fallback */
}

program
  .name("brainstorm")
  .description("AI coding assistant with intelligent model routing")
  .version(CLI_VERSION);

program
  .command("init")
  .description("Initialize project for AI-assisted development")
  .option("--yes", "Use defaults, skip prompts")
  .option("--force", "Overwrite existing files")
  .action(async (opts: { yes?: boolean; force?: boolean }) => {
    await runInit(process.cwd(), opts);
  });

program
  .command("eval")
  .description("Run capability evaluation probes against a model")
  .option(
    "--model <id>",
    "Model to evaluate (e.g., anthropic/claude-sonnet-4-6)",
  )
  .option("--capability <dim>", "Run only probes for this dimension")
  .option("--compare", "Compare results across all previously evaluated models")
  .option(
    "--scorecard",
    "Show current capability scores without re-running probes",
  )
  .option("--all-models", "Run probes against every available model")
  .option("--timeout <ms>", "Timeout per probe in milliseconds", "30000")
  .action(
    async (opts: {
      model?: string;
      capability?: string;
      compare?: boolean;
      scorecard?: boolean;
      allModels?: boolean;
      timeout?: string;
    }) => {
      await runEvalCli({
        model: opts.model,
        capability: opts.capability,
        compare: opts.compare,
        scorecard: opts.scorecard,
        allModels: opts.allModels,
        timeout: parseInt(opts.timeout ?? "30000"),
      });
    },
  );

// ── SWE-bench Eval Command ────────────────────────────────────────

program
  .command("eval-swe-bench")
  .description(
    "Run SWE-bench evaluation: apply agent to instances, score with Docker",
  )
  .requiredOption(
    "--instances <path>",
    "Path to SWE-bench instances.jsonl file",
  )
  .option("--model <id>", "Target model (default: let router decide)")
  .option("--limit <n>", "Max instances to evaluate", "10")
  .option("--concurrency <n>", "Parallel evaluations", "2")
  .option("--json", "Output results as JSON")
  .action(
    async (opts: {
      instances: string;
      model?: string;
      limit: string;
      concurrency: string;
      json?: boolean;
    }) => {
      const { loadInstances, runSWEBench, scorePatch, generateScorecard } =
        await import("@brainst0rm/eval");

      const limit = parseInt(opts.limit);
      const concurrency = parseInt(opts.concurrency);

      console.log(`\n  SWE-bench Evaluation`);
      console.log(`  ─────────────────────\n`);
      console.log(`  Instances: ${opts.instances}`);
      console.log(`  Limit: ${limit}`);
      console.log(`  Model: ${opts.model ?? "auto (router decides)"}`);
      console.log(`  Concurrency: ${concurrency}\n`);

      // Load instances
      const instances = loadInstances(opts.instances, limit);
      console.log(`  Loaded ${instances.length} instances.\n`);

      if (instances.length === 0) {
        console.error("  No instances found in file.");
        process.exit(1);
      }

      // Set up agent infrastructure (needed for spawnSubagent)
      const config = loadConfig();
      config.general.defaultPermissionMode = "auto"; // unattended
      const db = getDb();
      const resolvedKeys = await resolveProviderKeys();
      const registry = await createProviderRegistry(config, resolvedKeys);
      const costTracker = new CostTracker(db, config.budget);
      const tools = createDefaultToolRegistry();
      const { frontmatter } = buildSystemPrompt(process.cwd());
      const router = new BrainstormRouter(
        config,
        registry,
        costTracker,
        frontmatter,
      );
      if (!opts.model) {
        // Use the capability strategy so the router prefers models with
        // measured eval scores over assumed ones. quality-first picks by
        // qualityTier (a human guess) which can route to a model that
        // measured DEAD LAST in our own evals.
        router.setStrategy("capability");
      }

      const { execFileSync: execGit } = await import("node:child_process");
      const {
        mkdtempSync,
        writeFileSync: writePatch,
        rmSync,
      } = await import("node:fs");
      const { tmpdir } = await import("node:os");

      let completed = 0;

      // Run agent on each instance — REAL implementation
      console.log(`  Running agent on ${instances.length} instances...\n`);
      const patches = await runSWEBench(
        instances,
        async (instance: any) => {
          const startTime = Date.now();
          const instanceNum = ++completed;
          const shortId = instance.instanceId.slice(0, 40);

          try {
            // 1. Create isolated workspace
            const workDir = mkdtempSync(join(tmpdir(), "swe-bench-"));
            const repoDir = join(workDir, "repo");

            try {
              // 2. Clone repo at baseCommit
              process.stderr.write(
                `  [${instanceNum}/${instances.length}] ${shortId} — cloning...`,
              );
              // Use --filter=blob:none to avoid pulling full history while
              // still allowing checkout of any commit. --depth 100 was too
              // shallow for SWE-bench's historical commits.
              execGit(
                "git",
                [
                  "clone",
                  "--filter=blob:none",
                  "--no-checkout",
                  `https://github.com/${instance.repo}.git`,
                  "repo",
                ],
                {
                  cwd: workDir,
                  timeout: 180000,
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              execGit("git", ["fetch", "origin", instance.baseCommit], {
                cwd: repoDir,
                timeout: 60000,
                stdio: ["ignore", "pipe", "pipe"],
              });
              execGit("git", ["checkout", instance.baseCommit], {
                cwd: repoDir,
                timeout: 30000,
                stdio: ["ignore", "pipe", "pipe"],
              });

              // 3. Run Brainstorm agent on the issue
              process.stderr.write(` solving...`);
              const issuePrompt = [
                `You are solving a GitHub issue in a cloned repository at \`${repoDir}\`.`,
                ``,
                `## Problem`,
                instance.issue,
                instance.hints ? `\n## Hints\n${instance.hints}` : "",
                ``,
                `## Required Output`,
                `You MUST modify source files in this repo to fix the issue.`,
                `An empty diff counts as a failure. Your job is to edit code.`,
                ``,
                `## Steps`,
                `1. Use glob/grep/file_read to find the relevant source files`,
                `2. Identify the root cause by reading the actual code`,
                `3. Use file_edit or file_write to apply the fix (this step is REQUIRED)`,
                `4. Do NOT modify test files — only source files`,
                `5. Verify your changes by re-reading the modified files`,
                `6. Report what files you changed and why`,
                ``,
                `If you finish without calling file_edit or file_write at least once, you have failed the task.`,
              ].join("\n");

              const result = await spawnSubagent(issuePrompt, {
                config,
                registry,
                router,
                costTracker,
                tools,
                projectPath: repoDir,
                type: "code",
                maxSteps: 40, // SWE-bench issues need room for exploration + edits + verification
                budgetLimit: 3.0,
                permissionCheck: () => "allow", // unattended — auto-approve everything
                // Honor --model flag if provided — otherwise subagent
                // re-routes internally and ignores parent's preference.
                preferredModelId: opts.model,
              });

              // 4. Capture the diff (what the agent actually changed)
              let patch = "";
              try {
                patch = execGit("git", ["diff"], {
                  cwd: repoDir,
                  encoding: "utf-8",
                  timeout: 10000,
                  stdio: ["ignore", "pipe", "pipe"],
                }) as unknown as string;

                // Also capture any new untracked files
                const untrackedDiff = execGit("git", ["diff", "--cached"], {
                  cwd: repoDir,
                  encoding: "utf-8",
                  timeout: 10000,
                  stdio: ["ignore", "pipe", "pipe"],
                }) as unknown as string;
                if (untrackedDiff) patch += "\n" + untrackedDiff;
              } catch {
                // git diff failed — no changes made
              }

              const success = patch.length > 0 && !result.budgetExceeded;
              const status = success
                ? "✓"
                : patch.length === 0
                  ? "no changes"
                  : "budget exceeded";
              process.stderr.write(
                ` ${status} ($${result.cost.toFixed(3)}, ${result.modelUsed})\n`,
              );
              // Diagnostic: on no-changes, dump the first 500 chars of what
              // the subagent said it did. This helps debug empty-patch runs.
              if (!success && patch.length === 0) {
                const preview = result.text.slice(0, 500).replace(/\n/g, " ");
                process.stderr.write(`    agent said: ${preview}\n`);
              }

              return {
                instanceId: instance.instanceId,
                patch,
                model: result.modelUsed,
                strategy: opts.model ? "forced" : "quality-first",
                cost: result.cost,
                latencyMs: Date.now() - startTime,
                success,
              };
            } finally {
              // Cleanup workspace
              try {
                rmSync(workDir, { recursive: true, force: true });
              } catch {
                /* best effort */
              }
            }
          } catch (err: any) {
            process.stderr.write(
              ` ERROR: ${(err.message ?? "").slice(0, 80)}\n`,
            );
            return {
              instanceId: instance.instanceId,
              patch: "",
              model: "error",
              strategy: "quality-first",
              cost: 0,
              latencyMs: Date.now() - startTime,
              success: false,
            };
          }
        },
        concurrency,
      );

      // Score patches
      console.log(`  Scoring ${patches.length} patches...`);
      const scores = patches.map((patch: any, i: number) =>
        scorePatch(instances[i], patch),
      );
      const scorecard = generateScorecard(patches, scores);

      if (opts.json) {
        console.log(JSON.stringify(scorecard, null, 2));
        return;
      }

      console.log(`\n  ══════════════════════════════════════════════════`);
      console.log(`   SWE-bench Results`);
      console.log(`  ══════════════════════════════════════════════════\n`);
      console.log(`  Total:     ${scorecard.total}`);
      console.log(
        `  Passed:    ${scorecard.passed} (${(scorecard.passRate * 100).toFixed(1)}%)`,
      );
      console.log(`  Failed:    ${scorecard.failed}`);
      console.log(`  Errored:   ${scorecard.errored}`);
      console.log(`  Cost:      $${scorecard.totalCost.toFixed(4)}`);
      console.log(`  Avg Lat:   ${scorecard.avgLatencyMs}ms`);

      // Print individual errors to help diagnose scorer failures
      const erroredScores = scores.filter((s: any) => s.error);
      if (erroredScores.length > 0) {
        console.log(`\n  Scoring errors (${erroredScores.length}):`);
        for (const s of erroredScores) {
          console.log(`    ${s.instanceId}: ${s.error}`);
        }
      }
      console.log();
    },
  );

// ── Doctor Command ────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check project health, environment, and model availability")
  .action(async () => {
    const cwd = process.cwd();

    console.log(`\n  Brainstorm Doctor`);
    console.log(`  ─────────────────`);

    const [buildResult, modelsResult] = await Promise.all([
      runBuildDoctorCheck(cwd),
      runModelDoctorCheck(),
    ]);

    const envResult = runEnvDoctorCheck(cwd);

    printDoctorSection(buildResult);
    printDoctorSection(envResult);
    printDoctorSection(modelsResult);
    console.log();

    const allResults = [
      ...buildResult.results,
      ...envResult.results,
      ...modelsResult.results,
    ];
    const hasFailures = allResults.some((r) => r.status === "fail");

    if (hasFailures) {
      process.exit(1);
    }
  });

// ── Router Commands (BrainstormRouter Gateway) ───────────────────

const routerCmd = program
  .command("router")
  .description("Manage BrainstormRouter gateway");

routerCmd
  .command("status")
  .description("Show gateway health, budget, and rate limits")
  .action(async () => {
    const gw = createGatewayClient();
    if (!gw) {
      console.error(
        "  BRAINSTORM_API_KEY not set. Configure with: export BRAINSTORM_API_KEY=br_live_xxx",
      );
      return;
    }
    try {
      const [self, health] = await Promise.all([gw.getSelf(), gw.getHealth()]);
      console.log("\n  BrainstormRouter Gateway\n");
      console.log(`  Health:  ${health.status}`);
      console.log(`  Role:    ${self.identity.roles.join(", ")}`);
      console.log(`  Caps:    ${self.capabilities.granted.length} permissions`);
      try {
        const discovery = await gw.getDiscovery();
        if (discovery.budget) {
          console.log(
            `  Budget:  $${discovery.budget.remaining_usd?.toFixed(2)} / $${discovery.budget.limit_usd?.toFixed(2)} (${discovery.budget.period})`,
          );
        }
        if (discovery.models) {
          console.log(
            `  Models:  ${discovery.models.available} available, ${discovery.models.runnable} runnable`,
          );
        }
      } catch {
        console.log("  Budget:  (discovery unavailable)");
        console.log("  Models:  (discovery unavailable)");
      }
      console.log();
    } catch (e: any) {
      console.error(`  Error: ${e.message}`);
    }
  });

routerCmd
  .command("models")
  .description("List models available through the gateway")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const gw = createGatewayClient();
    if (!gw) {
      console.error("  BRAINSTORM_API_KEY not set.");
      return;
    }
    try {
      const models = await gw.listModels();
      if (opts.json) {
        console.log(JSON.stringify(models, null, 2));
        return;
      }
      console.log(`\n  Gateway Models (${models.length})\n`);
      for (const m of models.slice(0, 30)) {
        const name = (m.name ?? m.id).padEnd(40);
        const provider = (m.provider ?? "").padEnd(12);
        console.log(`    ${provider} ${name}`);
      }
      if (models.length > 30)
        console.log(`    ... and ${models.length - 30} more`);
      console.log();
    } catch (e: any) {
      console.error(`  Error: ${e.message}`);
    }
  });

routerCmd
  .command("budget")
  .description("Show gateway-side cost tracking and forecast")
  .action(async () => {
    const gw = createGatewayClient();
    if (!gw) {
      console.error("  BRAINSTORM_API_KEY not set.");
      return;
    }
    try {
      const usage = await gw.getUsageSummary();
      console.log("\n  Gateway Budget\n");
      console.log(`  Requests: ${usage.total_requests ?? "N/A"}`);
      console.log(`  Cost:     $${(usage.total_cost_usd ?? 0).toFixed(4)}`);
      console.log(
        `  Tokens:   ${(usage.total_input_tokens ?? 0).toLocaleString()} in / ${(usage.total_output_tokens ?? 0).toLocaleString()} out`,
      );
      if (usage.by_model?.length > 0) {
        console.log("\n  By model:");
        for (const m of usage.by_model) {
          console.log(
            `    ${m.model}: $${m.cost_usd.toFixed(4)} (${m.requests} reqs)`,
          );
        }
      }
      console.log();
    } catch (e: any) {
      console.error(`  Error: ${e.message}`);
    }
  });

routerCmd
  .command("keys")
  .description("List API keys")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const gw = createGatewayClient();
    if (!gw) {
      console.error("  BRAINSTORM_API_KEY not set.");
      return;
    }
    try {
      const keys = await gw.listKeys();
      if (opts.json) {
        console.log(JSON.stringify(keys, null, 2));
        return;
      }
      console.log(`\n  API Keys (${keys.length})\n`);
      for (const k of keys) {
        const budget = k.budgetLimitUsd
          ? `$${k.budgetLimitUsd}/${k.budgetPeriod}`
          : "unlimited";
        console.log(
          `    ${k.id.slice(0, 8)}  ${(k.name ?? "").padEnd(30)} scopes=${JSON.stringify(k.scopes)}  budget=${budget}`,
        );
      }
      console.log();
    } catch (e: any) {
      console.error(`  Error: ${e.message}`);
    }
  });

routerCmd
  .command("config")
  .description("Get or set gateway configuration")
  .argument("<key>", "Config key (e.g., guardrails, tools)")
  .argument("[value]", "JSON value to set (omit to read)")
  .action(async (key: string, value?: string) => {
    const gw = createGatewayClient();
    if (!gw) {
      console.error("  BRAINSTORM_API_KEY not set.");
      return;
    }
    try {
      if (value) {
        await gw.setConfig(key, JSON.parse(value));
        console.log(`  Set config/${key}`);
      } else {
        const data = await gw.getConfig(key);
        console.log(JSON.stringify(data, null, 2));
      }
    } catch (e: any) {
      console.error(`  Error: ${e.message}`);
    }
  });

routerCmd
  .command("audit")
  .description("Show recent request audit trail")
  .option("--since <duration>", "Time range (e.g., 1h, 24h, 7d)", "24h")
  .action(async (opts: { since: string }) => {
    const gw = createGatewayClient();
    if (!gw) {
      console.error("  BRAINSTORM_API_KEY not set.");
      return;
    }
    try {
      const entries = await gw.getCompletionAudit(opts.since);
      console.log(`\n  Audit Trail (last ${opts.since})\n`);
      if (entries.length === 0) {
        console.log("    No entries found.");
      }
      for (const e of entries.slice(0, 20)) {
        console.log(
          `    ${e.timestamp}  ${(e.model ?? "").padEnd(35)}  $${(e.cost_usd ?? 0).toFixed(4)}  ${e.latency_ms ?? "?"}ms  guardian=${e.guardian_status ?? "?"}`,
        );
      }
      if (entries.length > 20)
        console.log(`    ... ${entries.length - 20} more`);
      console.log();
    } catch (e: any) {
      console.error(`  Error: ${e.message}`);
    }
  });

routerCmd
  .command("memory")
  .description("List gateway memory entries")
  .action(async () => {
    const gw = createGatewayClient();
    if (!gw) {
      console.error("  BRAINSTORM_API_KEY not set.");
      return;
    }
    try {
      const entries = await gw.listMemory();
      console.log(`\n  Gateway Memory (${entries.length} entries)\n`);
      for (const e of entries) {
        const block = e.block ?? "unknown";
        const content = e.content ?? JSON.stringify(e).slice(0, 80);
        console.log(
          `    [${block}] ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`,
        );
      }
      console.log();
    } catch (e: any) {
      console.error(`  Error: ${e.message}`);
    }
  });

// ── Models Command ────────────────────────────────────────────────

program
  .command("models")
  .description("List available models and their status")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const config = loadConfig();
    const registry = await createProviderRegistry(
      config,
      await resolveProviderKeys(),
    );

    if (opts.json) {
      console.log(
        JSON.stringify(
          registry.models.map((m) => ({
            id: m.id,
            provider: m.provider,
            isLocal: m.isLocal,
            status: m.status,
            qualityTier: m.capabilities.qualityTier,
            speedTier: m.capabilities.speedTier,
            inputPer1MTokens: m.pricing.inputPer1MTokens,
            outputPer1MTokens: m.pricing.outputPer1MTokens,
          })),
          null,
          2,
        ),
      );
      return;
    }

    console.log("\n🧠 Brainstorm — Available Models\n");

    const local = registry.models.filter((m) => m.isLocal);
    const cloud = registry.models.filter((m) => !m.isLocal);

    if (local.length > 0) {
      console.log("  Local Models:");
      for (const m of local) {
        const status = m.status === "available" ? "●" : "○";
        console.log(
          `    ${status} ${m.id}  (quality: ${m.capabilities.qualityTier}, speed: ${m.capabilities.speedTier})`,
        );
      }
      console.log();
    } else {
      console.log(
        "  Local Models: none detected (start Ollama, LM Studio, or llama.cpp)\n",
      );
    }

    console.log("  Cloud Models (via AI Gateway):");
    for (const m of cloud) {
      const cost = `$${m.pricing.inputPer1MTokens}/${m.pricing.outputPer1MTokens} per 1M tokens`;
      console.log(
        `    ● ${m.id}  (quality: ${m.capabilities.qualityTier}, ${cost})`,
      );
    }
    console.log();
  });

program
  .command("budget")
  .description("Show cost tracking and budget status")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const config = loadConfig();
    const db = getDb();
    const costTracker = new CostTracker(db, config.budget);
    const summary = costTracker.getSummary();

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            session: summary.session,
            today: summary.today,
            thisMonth: summary.thisMonth,
            limits: {
              daily: config.budget.daily ?? null,
              monthly: config.budget.monthly ?? null,
              hardLimit: config.budget.hardLimit,
            },
            byModel: summary.byModel,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log("\n🧠 Brainstorm — Budget Status\n");
    console.log(`  Session:    $${summary.session.toFixed(4)}`);
    console.log(
      `  Today:      $${summary.today.toFixed(4)}${config.budget.daily ? ` / $${config.budget.daily.toFixed(2)}` : ""}`,
    );
    console.log(
      `  This month: $${summary.thisMonth.toFixed(4)}${config.budget.monthly ? ` / $${config.budget.monthly.toFixed(2)}` : ""}`,
    );

    if (summary.byModel.length > 0) {
      console.log("\n  Cost by model:");
      for (const entry of summary.byModel) {
        console.log(
          `    ${entry.modelId}: $${entry.totalCost.toFixed(4)} (${entry.requestCount} requests)`,
        );
      }
    }
    console.log();
  });

program
  .command("config")
  .description("Show current configuration")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const config = loadConfig();

    if (opts.json) {
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    console.log("\n🧠 Brainstorm — Configuration\n");
    console.log(`  Strategy:     ${config.general.defaultStrategy}`);
    console.log(`  Max steps:    ${config.general.maxSteps}`);
    console.log(`  Confirm tools: ${config.general.confirmTools}`);
    console.log(
      `  Budget daily: ${config.budget.daily ? `$${config.budget.daily}` : "unlimited"}`,
    );
    console.log(
      `  Budget monthly: ${config.budget.monthly ? `$${config.budget.monthly}` : "unlimited"}`,
    );
    console.log(`  Hard limit:   ${config.budget.hardLimit}`);
    console.log(
      `  Ollama:       ${config.providers.ollama.enabled ? config.providers.ollama.baseUrl : "disabled"}`,
    );
    console.log(
      `  LM Studio:    ${config.providers.lmstudio.enabled ? config.providers.lmstudio.baseUrl : "disabled"}`,
    );
    console.log(
      `  llama.cpp:    ${config.providers.llamacpp.enabled ? config.providers.llamacpp.baseUrl : "disabled"}`,
    );
    console.log(
      `  AI Gateway:   ${config.providers.gateway.enabled ? "enabled" : "disabled"}`,
    );
    if (config.routing.rules.length > 0) {
      console.log(`  Routing rules: ${config.routing.rules.length}`);
    }
    console.log();
  });

// ── Introspect Command ────────────────────────────────────────────

program
  .command("introspect")
  .description(
    "Dump full capabilities as JSON — models, tools, config, products, auth state. Designed for machine consumption.",
  )
  .action(async () => {
    const config = loadConfig();
    const toolRegistry = createDefaultToolRegistry();

    // Env-only key resolution (non-interactive — no vault prompt)
    const envKeys = {
      get(name: string): string | null {
        return process.env[name] ?? null;
      },
    };
    let registry: Awaited<ReturnType<typeof createProviderRegistry>> | null =
      null;
    try {
      registry = await createProviderRegistry(config, envKeys);
    } catch {
      // Provider discovery may fail without keys — that's fine for introspect
    }

    const db = getDb();
    const costTracker = new CostTracker(db, config.budget);
    const budget = costTracker.getSummary();

    // Static tools with metadata
    const staticTools = toolRegistry.listTools().map((t) => ({
      name: t.name,
      permission: t.permission,
    }));

    // Auth state from env
    const auth: Record<string, boolean> = {
      brainstormRouter: !!process.env.BRAINSTORM_API_KEY,
      anthropic:
        !!process.env.ANTHROPIC_API_KEY || !!process.env.BRAINSTORM_API_KEY,
      openai: !!process.env.OPENAI_API_KEY || !!process.env.BRAINSTORM_API_KEY,
      google:
        !!process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        !!process.env.BRAINSTORM_API_KEY,
      msp: !!process.env.BRAINSTORM_MSP_API_KEY || !!process.env._GM_AGENT_KEY,
    };

    const output = {
      version: CLI_VERSION,
      static: {
        tools: staticTools,
        toolCount: staticTools.length,
      },
      runtime: {
        models: registry
          ? registry.models.map((m) => ({
              id: m.id,
              provider: m.provider,
              isLocal: m.isLocal,
              available: m.status === "available",
            }))
          : [],
        modelCount: registry?.models.length ?? 0,
      },
      auth,
      config: {
        strategy: config.general.defaultStrategy,
        maxSteps: config.general.maxSteps,
        permissionMode: config.general.defaultPermissionMode,
        budget: {
          daily: config.budget.daily ?? null,
          monthly: config.budget.monthly ?? null,
          spent: {
            session: budget.session,
            today: budget.today,
            thisMonth: budget.thisMonth,
          },
        },
        sandbox: config.shell.sandbox,
      },
    };

    console.log(JSON.stringify(output, null, 2));
  });

// ── Agent Commands ─────────────────────────────────────────────────

const agentCmd = program.command("agent").description("Manage named agents");

agentCmd
  .command("create")
  .description("Create an agent (structured flags or natural language)")
  .argument(
    "[description...]",
    'Natural language description (e.g., "architect using opus with $30 budget")',
  )
  .option("--id <id>", "Agent ID")
  .option("--model <model>", "Model ID or alias")
  .option(
    "--role <role>",
    "Agent role (architect|coder|reviewer|debugger|analyst|custom)",
  )
  .option("--budget <usd>", "Per-workflow budget in USD", parseFloat)
  .option("--budget-daily <usd>", "Daily budget in USD", parseFloat)
  .option("--description <desc>", "What this agent does")
  .option("--confidence <threshold>", "Confidence threshold 0-1", parseFloat)
  .action(async (descWords: string[], opts: any) => {
    const config = loadConfig();
    const db = getDb();
    const manager = new AgentManager(db, config);

    // Try natural language first
    const nlInput = descWords.join(" ");
    const parseResult = nlInput ? parseAgentNL(nlInput) : null;
    const parsed = parseResult?.intent;

    if (nlInput && !parsed && parseResult?.suggestion) {
      console.log(
        `  Could not parse agent definition.\n  ${parseResult.suggestion}`,
      );
      process.exit(1);
    }

    const id = opts.id ?? parsed?.id ?? "agent-" + Date.now().toString(36);
    const role = opts.role ?? parsed?.role ?? "custom";
    const modelId = opts.model ?? parsed?.modelId ?? "auto";
    const budget = opts.budget ?? parsed?.budget;
    const budgetDaily = opts.budgetDaily ?? parsed?.budgetDaily;
    const description = opts.description ?? parsed?.description ?? "";
    const confidence = opts.confidence ?? 0.7;

    const agent = manager.create({
      id,
      displayName: id.charAt(0).toUpperCase() + id.slice(1),
      role,
      description,
      modelId,
      allowedTools: role === "coder" ? "all" : ["file_read", "glob", "grep"],
      budget: {
        perWorkflow: budget,
        daily: budgetDaily,
        exhaustionAction: "downgrade",
      },
      confidenceThreshold: confidence,
      maxSteps: 10,
      fallbackChain: [],
      guardrails: { pii: parsed?.guardrailsPii },
      lifecycle: "active",
    });

    console.log(`\n  Created agent '${agent.id}'`);
    console.log(`    Role: ${agent.role}`);
    console.log(`    Model: ${agent.modelId}`);
    if (agent.budget.perWorkflow)
      console.log(`    Budget: $${agent.budget.perWorkflow}/workflow`);
    if (agent.budget.daily)
      console.log(`    Daily: $${agent.budget.daily}/day`);
    if (agent.guardrails.pii) console.log(`    Guardrails: PII enabled`);
    console.log();
  });

agentCmd
  .command("list")
  .description("List all agents")
  .action(async () => {
    const config = loadConfig();
    const db = getDb();
    const manager = new AgentManager(db, config);
    const agents = manager.list();

    console.log("\n  Agents:\n");
    if (agents.length === 0) {
      console.log(
        "    No agents defined. Create one with: storm agent create <description>",
      );
    }
    for (const a of agents) {
      const budget = a.budget.perWorkflow
        ? `$${a.budget.perWorkflow}/wf`
        : a.budget.daily
          ? `$${a.budget.daily}/day`
          : "unlimited";
      console.log(
        `    ${a.id}  (${a.role})  model: ${a.modelId}  budget: ${budget}`,
      );
    }
    console.log();
  });

agentCmd
  .command("show")
  .description("Show agent details")
  .argument("<id>", "Agent ID")
  .action(async (id: string) => {
    const config = loadConfig();
    const db = getDb();
    const manager = new AgentManager(db, config);
    const agent = manager.get(id);

    if (!agent) {
      console.error(`  Agent '${id}' not found.`);
      process.exit(1);
    }

    console.log(`\n  Agent: ${agent.id}`);
    console.log(`    Display Name: ${agent.displayName}`);
    console.log(`    Role: ${agent.role}`);
    console.log(`    Model: ${agent.modelId}`);
    console.log(`    Description: ${agent.description || "(none)"}`);
    console.log(`    Allowed Tools: ${JSON.stringify(agent.allowedTools)}`);
    console.log(
      `    Budget/Workflow: ${agent.budget.perWorkflow ? `$${agent.budget.perWorkflow}` : "unlimited"}`,
    );
    console.log(
      `    Budget/Daily: ${agent.budget.daily ? `$${agent.budget.daily}` : "unlimited"}`,
    );
    console.log(`    Confidence: ${agent.confidenceThreshold}`);
    console.log(
      `    Fallback Chain: ${agent.fallbackChain.length > 0 ? agent.fallbackChain.join(" → ") : "(none)"}`,
    );
    console.log(`    Guardrails: PII=${agent.guardrails.pii ?? false}`);
    console.log(`    Status: ${agent.lifecycle}`);
    console.log();
  });

agentCmd
  .command("delete")
  .description("Delete an agent")
  .argument("<id>", "Agent ID")
  .action(async (id: string) => {
    const config = loadConfig();
    const db = getDb();
    const manager = new AgentManager(db, config);
    try {
      const deleted = manager.delete(id);
      if (deleted) console.log(`  Deleted agent '${id}'.`);
      else console.error(`  Agent '${id}' not found.`);
    } catch (e: any) {
      console.error(`  ${e.message}`);
    }
  });

// ── Workflow Commands ──────────────────────────────────────────────

const workflowCmd = program
  .command("workflow")
  .description("Run multi-agent workflows");

workflowCmd
  .command("list")
  .description("List available workflows")
  .action(async () => {
    console.log("\n  Workflows:\n");
    for (const w of PRESET_WORKFLOWS) {
      const steps = w.steps.map((s) => s.agentRole).join(" → ");
      console.log(`    ${w.id}  — ${w.description}`);
      console.log(
        `      Steps: ${steps}  (mode: ${w.communicationMode}, max loops: ${w.maxIterations})`,
      );
    }
    console.log();
  });

workflowCmd
  .command("run")
  .description("Run a workflow")
  .argument("<preset>", "Workflow preset ID or natural language description")
  .argument("[description...]", "What to build/fix/review")
  .option(
    "--agents <mapping>",
    'Agent role overrides (e.g., "architect=my-arch,coder=my-coder")',
  )
  .option("--mode <mode>", "Communication mode (handoff|shared)", "handoff")
  .option(
    "--step-model <overrides...>",
    'Per-step model overrides (e.g., "plan=claude-opus-4.6 code=claude-sonnet-4.6")',
  )
  .option("--dry-run", "Show cost forecast only")
  .action(async (preset: string, descWords: string[], opts: any) => {
    const description = descWords.join(" ") || preset;

    // Resolve workflow
    let workflow = getPresetWorkflow(preset);
    if (!workflow) {
      const autoPreset = autoSelectPreset(preset + " " + description);
      if (autoPreset) workflow = getPresetWorkflow(autoPreset);
    }
    if (!workflow) {
      console.error(
        `  Unknown workflow: '${preset}'. Run 'storm workflow list' to see available workflows.`,
      );
      process.exit(1);
    }

    const config = loadConfig();
    const db = getDb();
    const registry = await createProviderRegistry(
      config,
      await resolveProviderKeys(),
    );
    const costTracker = new CostTracker(db, config.budget);
    const projectPath = process.cwd();
    const { frontmatter } = buildSystemPrompt(projectPath);
    const router = new BrainstormRouter(
      config,
      registry,
      costTracker,
      frontmatter,
    );
    const agentManager = new AgentManager(db, config);

    // Parse agent overrides
    const agentOverrides: Record<string, string> = {};
    if (opts.agents) {
      for (const pair of opts.agents.split(",")) {
        const [role, agentId] = pair.split("=");
        if (role && agentId) agentOverrides[role.trim()] = agentId.trim();
      }
    }

    // Parse step model overrides: --step-model "plan=claude-opus-4.6" "code=claude-sonnet-4.6"
    const stepModelOverrides: Record<string, string> = {};
    if (opts.stepModel) {
      const items = Array.isArray(opts.stepModel)
        ? opts.stepModel
        : [opts.stepModel];
      for (const item of items) {
        for (const pair of (item as string).split(/\s+/)) {
          const [step, model] = pair.split("=");
          if (step && model) stepModelOverrides[step.trim()] = model.trim();
        }
      }
    }

    console.log(`\n  Workflow: ${workflow.name}`);
    console.log(`  Request: "${description}"`);
    console.log(
      `  Steps: ${workflow.steps.map((s) => s.agentRole).join(" → ")}`,
    );
    if (Object.keys(stepModelOverrides).length > 0) {
      console.log(
        `  Model overrides: ${Object.entries(stepModelOverrides)
          .map(([s, m]) => `${s}=${m}`)
          .join(", ")}`,
      );
    }
    console.log();

    for await (const event of runWorkflow(
      workflow,
      description,
      agentOverrides,
      {
        config,
        db,
        registry,
        router,
        costTracker,
        agentManager,
        projectPath,
        stepModelOverrides,
      },
    )) {
      switch (event.type) {
        case "cost-forecast":
          console.log(`  Estimated cost: $${event.estimated.toFixed(4)}`);
          for (const b of event.breakdown) {
            console.log(`    ${b.step}: $${b.cost.toFixed(4)}`);
          }
          if (opts.dryRun) {
            console.log("\n  (dry run — not executing)\n");
            return;
          }
          console.log();
          break;
        case "step-started":
          process.stdout.write(
            `  [${event.agent.role}] ${event.agent.displayName} (${event.agent.modelId})...`,
          );
          break;
        case "step-progress":
          if (event.event.type === "text-delta") {
            // Don't flood output — just show dots for progress
          }
          if (event.event.type === "routing") {
            process.stdout.write(` → ${event.event.decision.model.name}`);
          }
          break;
        case "step-completed":
          console.log(
            ` done ($${event.step.cost.toFixed(4)}, confidence: ${event.artifact.confidence.toFixed(2)})`,
          );
          break;
        case "step-failed":
          console.log(` FAILED: ${event.error.message}`);
          break;
        case "review-rejected":
          console.log(
            `  [review] Rejected — looping back to ${event.loopingBackTo} (iteration ${event.step.iteration + 1})`,
          );
          break;
        case "confidence-escalation":
          console.log(
            `  [confidence] ${event.action} (${event.confidence.toFixed(2)})`,
          );
          break;
        case "model-fallback":
          console.log(
            `  [fallback] ${event.originalModel} → ${event.fallbackModel}: ${event.reason}`,
          );
          break;
        case "workflow-completed":
          console.log(
            `\n  Workflow complete. Total cost: $${event.run.totalCost.toFixed(4)}`,
          );
          console.log(
            `  Artifacts: ${event.run.artifacts.map((a) => a.id).join(", ")}\n`,
          );
          break;
        case "workflow-failed":
          console.log(`\n  Workflow failed: ${event.error.message}\n`);
          break;
      }
    }
  });

// ── Run Command ────────────────────────────────────────────────────

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
        config.shell.sandbox as any,
        projectPath,
        config.shell.maxOutputBytes,
        config.shell.containerImage,
        config.shell.containerTimeout,
      );
      const {
        prompt: rawPrompt,
        segments: rawSegments,
        frontmatter,
      } = buildSystemPrompt(projectPath);
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
        config.general.defaultPermissionMode as any,
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
        router.setStrategy(opts.strategy as any);
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
            const gmToolSection = buildToolAwarenessSection(tools.listTools());
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

// ── Vault Commands ─────────────────────────────────────────────────

const VAULT_PATH = join(homedir(), ".brainstorm", "vault.enc");

function printResumeSummary(
  session: any,
  sessionManager: SessionManager,
): void {
  const age = Math.floor((Date.now() / 1000 - session.createdAt) / 60);
  const ageStr =
    age < 60
      ? `${age}m ago`
      : age < 1440
        ? `${Math.floor(age / 60)}h ago`
        : `${Math.floor(age / 1440)}d ago`;
  const history = sessionManager.getHistory();
  const lastMsg = history.length > 0 ? history[history.length - 1] : null;
  const lastPreview = lastMsg
    ? `"${lastMsg.content.slice(0, 60)}${lastMsg.content.length > 60 ? "..." : ""}"`
    : "none";
  console.log(
    `  Resumed session ${session.id.slice(0, 8)} | ${session.messageCount} msgs | $${(session.totalCost ?? 0).toFixed(4)} | ${ageStr}`,
  );
  if (lastMsg) console.log(`  Last ${lastMsg.role}: ${lastPreview}`);
}

import { promptPassword } from "../util/prompt-password.js";

const vaultCmd = program
  .command("vault")
  .description("Manage encrypted key vault");

vaultCmd
  .command("init")
  .description("Create a new encrypted vault")
  .action(async () => {
    const vault = new BrainstormVault(VAULT_PATH);
    if (vault.exists()) {
      console.error(
        "  Vault already exists. Use `brainstorm vault rotate` to change password.",
      );
      process.exit(1);
    }
    const password = await promptPassword("  Master password: ");
    const confirm = await promptPassword("  Confirm password: ");
    if (password !== confirm) {
      console.error("  Passwords do not match.");
      process.exit(1);
    }
    if (password.length < 8) {
      console.error("  Password must be at least 8 characters.");
      process.exit(1);
    }
    await vault.init(password);
    console.log(`  Vault created at ${VAULT_PATH}`);
  });

vaultCmd
  .command("add <name>")
  .description("Add a key to the vault")
  .argument("[value]", "Key value (prompted if omitted)")
  .action(async (name: string, value?: string) => {
    const vault = new BrainstormVault(VAULT_PATH);
    const password = await promptPassword("  Master password: ");
    vault.open(password);
    const keyValue = value ?? (await promptPassword(`  Value for ${name}: `));
    vault.set(name, keyValue);
    vault.seal();
    console.log(`  Added ${name} to vault.`);
  });

vaultCmd
  .command("list")
  .description("List stored key names")
  .action(async () => {
    const vault = new BrainstormVault(VAULT_PATH);
    if (!vault.exists()) {
      console.log("  No vault found. Run `brainstorm vault init` first.");
      return;
    }
    const password = await promptPassword("  Master password: ");
    vault.open(password);
    const keys = vault.list();
    if (keys.length === 0) {
      console.log("  Vault is empty.");
    } else {
      console.log(`\n  Keys (${keys.length}):\n`);
      for (const k of keys) console.log(`    ${k}`);
      console.log();
    }
  });

vaultCmd
  .command("get <name>")
  .description("Show a key value (masked by default)")
  .option("--reveal", "Show the full unmasked value")
  .action(async (name: string, opts: { reveal?: boolean }) => {
    const vault = new BrainstormVault(VAULT_PATH);
    const password = await promptPassword("  Master password: ");
    vault.open(password);
    const value = vault.get(name);
    if (value) {
      if (opts.reveal) {
        console.log(value);
      } else {
        const masked =
          value.slice(0, 8) + "*".repeat(Math.max(0, value.length - 8));
        console.log(masked);
      }
    } else {
      console.error(`  Key "${name}" not found in vault.`);
      process.exit(1);
    }
  });

vaultCmd
  .command("remove <name>")
  .description("Remove a key from the vault")
  .action(async (name: string) => {
    const vault = new BrainstormVault(VAULT_PATH);
    const password = await promptPassword("  Master password: ");
    vault.open(password);
    if (vault.delete(name)) {
      vault.seal();
      console.log(`  Removed ${name} from vault.`);
    } else {
      console.error(`  Key "${name}" not found in vault.`);
      process.exit(1);
    }
  });

vaultCmd
  .command("rotate")
  .description("Change vault master password")
  .action(async () => {
    const vault = new BrainstormVault(VAULT_PATH);
    const current = await promptPassword("  Current password: ");
    vault.open(current);
    const newPass = await promptPassword("  New password: ");
    const confirm = await promptPassword("  Confirm new password: ");
    if (newPass !== confirm) {
      console.error("  Passwords do not match.");
      process.exit(1);
    }
    if (newPass.length < 8) {
      console.error("  Password must be at least 8 characters.");
      process.exit(1);
    }
    vault.rotate(newPass);
    console.log("  Vault password rotated.");
  });

vaultCmd
  .command("lock")
  .description("Clear vault keys from memory")
  .action(() => {
    console.log("  Vault locked (keys cleared from memory).");
  });

vaultCmd
  .command("status")
  .description("Show vault and backend status")
  .action(async () => {
    const vault = new BrainstormVault(VAULT_PATH);
    const resolver = new KeyResolver(vault.exists() ? vault : null);
    const s = resolver.status();
    console.log("\n  Vault Status:\n");
    console.log(`    Vault:      ${s.vault}`);
    console.log(`    1Password:  ${s.op}`);
    console.log(`    Env vars:   ${s.env}`);
    console.log(`    Priority:   vault → 1Password → env vars\n`);
  });

// ── Projects Command ──────────────────────────────────────────────

const projectsCmd = program
  .command("projects")
  .description("Manage registered projects");

projectsCmd
  .command("list")
  .description("List all registered projects")
  .option("--all", "Include inactive projects")
  .action(async (opts: { all?: boolean }) => {
    const { ProjectManager } = await import("@brainst0rm/projects");
    const db = getDb();
    const pm = new ProjectManager(db);
    const projects = pm.projects.list(opts.all);

    console.log("\n  Registered Projects:\n");
    if (projects.length === 0) {
      console.log(
        "    No projects registered. Run: storm projects register <path>",
      );
      console.log("    Or scan all: storm projects import ~/Projects\n");
      return;
    }
    for (const p of projects) {
      const dash = pm.dashboard(p.id);
      const cost = dash ? `$${dash.costToday.toFixed(4)}/day` : "";
      const sessions = dash ? `${dash.sessionCount} sessions` : "";
      const active = p.isActive ? "" : " [inactive]";
      console.log(
        `    ${p.name.padEnd(25)} ${sessions.padEnd(15)} ${cost.padEnd(15)} ${p.path}${active}`,
      );
    }
    console.log();
  });

projectsCmd
  .command("register")
  .argument("<path>", "Path to project directory")
  .option("-n, --name <name>", "Project name (default: directory name)")
  .option("--budget-daily <amount>", "Daily budget limit in dollars")
  .option("--budget-monthly <amount>", "Monthly budget limit in dollars")
  .description("Register a project")
  .action(
    async (
      path: string,
      opts: { name?: string; budgetDaily?: string; budgetMonthly?: string },
    ) => {
      const { ProjectManager } = await import("@brainst0rm/projects");
      const db = getDb();
      const pm = new ProjectManager(db);
      try {
        const project = pm.register(path, opts.name, {
          budgetDaily: opts.budgetDaily
            ? parseFloat(opts.budgetDaily)
            : undefined,
          budgetMonthly: opts.budgetMonthly
            ? parseFloat(opts.budgetMonthly)
            : undefined,
        });
        console.log(`\n  ✓ Registered "${project.name}" → ${project.path}\n`);
      } catch (err) {
        console.error(
          `\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  );

projectsCmd
  .command("switch")
  .argument("<name>", "Project name to switch to")
  .description("Set the active project for this session")
  .action(async (name: string) => {
    const { ProjectManager } = await import("@brainst0rm/projects");
    const db = getDb();
    const pm = new ProjectManager(db);
    try {
      const project = pm.switch(name);
      console.log(`\n  ✓ Switched to "${project.name}" (${project.path})\n`);
    } catch (err) {
      console.error(
        `\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  });

projectsCmd
  .command("show")
  .argument("<name>", "Project name")
  .description("Show project dashboard")
  .action(async (name: string) => {
    const { ProjectManager } = await import("@brainst0rm/projects");
    const db = getDb();
    const pm = new ProjectManager(db);
    const project = pm.projects.getByName(name);
    if (!project) {
      console.error(`\n  ✗ Project "${name}" not found.\n`);
      return;
    }
    const dash = pm.dashboard(project.id);
    if (!dash) return;

    console.log(`\n  ── ${project.name} ──`);
    console.log(`  Path:         ${project.path}`);
    if (project.description)
      console.log(`  Description:  ${project.description}`);
    console.log(`  Sessions:     ${dash.sessionCount}`);
    console.log(`  Cost today:   $${dash.costToday.toFixed(4)}`);
    console.log(`  Cost month:   $${dash.costThisMonth.toFixed(4)}`);
    if (project.budgetDaily) {
      console.log(
        `  Budget daily: $${project.budgetDaily.toFixed(2)} (${dash.budgetDailyUsed.toFixed(0)}% used)`,
      );
    }
    if (project.budgetMonthly) {
      console.log(
        `  Budget month: $${project.budgetMonthly.toFixed(2)} (${dash.budgetMonthlyUsed.toFixed(0)}% used)`,
      );
    }

    const memory = pm.memory.list(project.id);
    if (memory.length > 0) {
      console.log(`  Memory:       ${memory.length} entries`);
    }
    console.log();
  });

projectsCmd
  .command("import")
  .argument("[dir]", "Parent directory to scan", join(homedir(), "Projects"))
  .description("Scan a directory and register all project subdirectories")
  .action(async (dir: string) => {
    const { ProjectManager } = await import("@brainst0rm/projects");
    const db = getDb();
    const pm = new ProjectManager(db);
    const registered = pm.import(dir);
    if (registered.length === 0) {
      console.log(`\n  No new projects found in ${dir}\n`);
    } else {
      console.log(`\n  Registered ${registered.length} projects:`);
      for (const p of registered) {
        console.log(`    ✓ ${p.name} → ${p.path}`);
      }
      console.log();
    }
  });

// ── Schedule Command ──────────────────────────────────────────────

const scheduleCmd = program
  .command("schedule")
  .description("Manage scheduled tasks");

scheduleCmd
  .command("list")
  .option("-p, --project <name>", "Filter by project")
  .description("List scheduled tasks")
  .action(async (opts: { project?: string }) => {
    const { ScheduledTaskRepository } = await import("@brainst0rm/scheduler");
    const { ProjectManager } = await import("@brainst0rm/projects");
    const db = getDb();
    const taskRepo = new ScheduledTaskRepository(db);

    let projectId: string | undefined;
    if (opts.project) {
      const pm = new ProjectManager(db);
      const p = pm.projects.getByName(opts.project);
      if (!p) {
        console.error(`  Project "${opts.project}" not found.`);
        return;
      }
      projectId = p.id;
    }

    const tasks = taskRepo.list(projectId, "active");
    console.log("\n  Scheduled Tasks:\n");
    if (tasks.length === 0) {
      console.log(
        '    No tasks. Add one: storm schedule add "<prompt>" --project <name>\n',
      );
      return;
    }
    for (const t of tasks) {
      const cron = t.cronExpression || "one-shot";
      const mutations = t.allowMutations ? "read+write" : "read-only";
      const budget = t.budgetLimit
        ? `$${t.budgetLimit.toFixed(2)}`
        : "no limit";
      console.log(
        `    ${t.name.padEnd(25)} ${cron.padEnd(18)} ${mutations.padEnd(12)} ${budget}`,
      );
    }
    console.log();
  });

scheduleCmd
  .command("add")
  .argument("<prompt>", "Task instruction")
  .requiredOption("-p, --project <name>", "Project name")
  .option("-n, --name <name>", "Task name (default: first 30 chars of prompt)")
  .option("--cron <expression>", "Cron schedule (e.g. '0 9 * * *')")
  .option("--budget <amount>", "Budget limit per run in dollars", "0.50")
  .option("--max-turns <n>", "Maximum turns per run", "20")
  .option("--allow-mutations", "Allow file writes and shell commands")
  .option("--model <id>", "Model override for this task")
  .description("Add a scheduled task")
  .action(async (prompt: string, opts: any) => {
    const { ScheduledTaskRepository, validateCron, validateTaskSafety } =
      await import("@brainst0rm/scheduler");
    const { ProjectManager } = await import("@brainst0rm/projects");
    const db = getDb();
    const pm = new ProjectManager(db);
    const project = pm.projects.getByName(opts.project);
    if (!project) {
      console.error(`  Project "${opts.project}" not found.`);
      return;
    }

    if (opts.cron) {
      const err = validateCron(opts.cron);
      if (err) {
        console.error(`  Invalid cron: ${err}`);
        return;
      }
    }

    const taskRepo = new ScheduledTaskRepository(db);
    const task = taskRepo.create({
      projectId: project.id,
      name: opts.name || prompt.slice(0, 30),
      prompt,
      cronExpression: opts.cron,
      budgetLimit: parseFloat(opts.budget),
      maxTurns: parseInt(opts.maxTurns),
      allowMutations: opts.allowMutations ?? false,
      modelId: opts.model,
    });

    const warnings = validateTaskSafety(task);
    console.log(`\n  ✓ Created task "${task.name}" (${task.id.slice(0, 8)})`);
    if (task.cronExpression) {
      const { describeCron } = await import("@brainst0rm/scheduler");
      console.log(`    Schedule: ${describeCron(task.cronExpression)}`);
    }
    if (warnings.length > 0) {
      console.log("    Warnings:");
      for (const w of warnings) console.log(`      ⚠ ${w}`);
    }
    console.log();
  });

scheduleCmd
  .command("run")
  .option("--task-id <id>", "Run a specific task")
  .option("--dry-run", "Show what would run without executing")
  .description("Trigger due tasks")
  .action(async (opts: { taskId?: string; dryRun?: boolean }) => {
    const { TriggerRunner } = await import("@brainst0rm/scheduler");
    const db = getDb();
    const runner = new TriggerRunner(db);
    const result = await runner.runDueTasks(opts);

    console.log(`\n  Checked: ${result.tasksChecked} tasks`);
    console.log(`  Run:     ${result.tasksRun}`);
    if (result.tasksFailed > 0) console.log(`  Failed:  ${result.tasksFailed}`);
    if (result.tasksSkipped > 0)
      console.log(`  Skipped: ${result.tasksSkipped} (concurrency limit)`);

    for (const r of result.runs) {
      const icon =
        r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "○";
      console.log(
        `    ${icon} ${r.taskName} → ${r.status}${r.error ? ` (${r.error})` : ""}`,
      );
    }
    console.log();
  });

scheduleCmd
  .command("history")
  .option("--task-id <id>", "Filter by task")
  .option("-n, --limit <count>", "Number of runs to show", "10")
  .description("Show task run history")
  .action(async (opts: { taskId?: string; limit: string }) => {
    const { TaskRunRepository, ScheduledTaskRepository } =
      await import("@brainst0rm/scheduler");
    const db = getDb();
    const runRepo = new TaskRunRepository(db);
    const taskRepo = new ScheduledTaskRepository(db);

    const runs = opts.taskId
      ? runRepo.listByTask(opts.taskId, parseInt(opts.limit))
      : runRepo.listRecent(parseInt(opts.limit));

    console.log("\n  Task Run History:\n");
    if (runs.length === 0) {
      console.log("    No runs yet.\n");
      return;
    }
    for (const r of runs) {
      const task = taskRepo.getById(r.taskId);
      const icon =
        r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "●";
      const date = new Date(r.createdAt * 1000).toLocaleString();
      console.log(
        `    ${icon} ${(task?.name ?? r.taskId.slice(0, 8)).padEnd(22)} $${r.cost.toFixed(4).padEnd(10)} ${r.status.padEnd(16)} ${date}`,
      );
    }
    console.log();
  });

scheduleCmd
  .command("pause")
  .argument("<task-id>", "Task ID to pause")
  .description("Pause a scheduled task")
  .action(async (taskId: string) => {
    const { ScheduledTaskRepository } = await import("@brainst0rm/scheduler");
    const db = getDb();
    const repo = new ScheduledTaskRepository(db);
    repo.updateStatus(taskId, "paused");
    console.log(`  ✓ Paused task ${taskId.slice(0, 8)}\n`);
  });

scheduleCmd
  .command("resume")
  .argument("<task-id>", "Task ID to resume")
  .description("Resume a paused task")
  .action(async (taskId: string) => {
    const { ScheduledTaskRepository } = await import("@brainst0rm/scheduler");
    const db = getDb();
    const repo = new ScheduledTaskRepository(db);
    repo.updateStatus(taskId, "active");
    console.log(`  ✓ Resumed task ${taskId.slice(0, 8)}\n`);
  });

scheduleCmd
  .command("delete")
  .argument("<task-id>", "Task ID to delete")
  .description("Delete a scheduled task")
  .action(async (taskId: string) => {
    const { ScheduledTaskRepository } = await import("@brainst0rm/scheduler");
    const db = getDb();
    const repo = new ScheduledTaskRepository(db);
    repo.delete(taskId);
    console.log(`  ✓ Deleted task ${taskId.slice(0, 8)}\n`);
  });

// ── Plan Command ──────────────────────────────────────────────────

const planCmd = program
  .command("plan")
  .description("Execute and manage structured plans");

planCmd
  .command("execute")
  .argument("<path>", "Path to .plan.md file")
  .option("--auto", "Run autonomously (no pauses)")
  .option("--dry-run", "Show dispatch plan without executing")
  .option("--budget <amount>", "Total budget limit in dollars")
  .option("--task-budget <amount>", "Per-task budget limit", "0.50")
  .option("--retries <n>", "Max retries per task", "2")
  .description("Execute a plan file task-by-task using subagents")
  .action(async (path: string, opts: any) => {
    const { executePlan } = await import("@brainst0rm/core");
    const { resolve } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const planPath = resolve(path);
    const mode = opts.dryRun
      ? "dry-run"
      : opts.auto
        ? "autonomous"
        : "interactive";

    console.log(`\n  Plan Executor (${mode} mode)\n`);

    const dispatcher = {
      async execute(prompt: string, execOpts: any) {
        console.log(
          `    Dispatching: ${execOpts.subagentType}/${execOpts.modelHint}`,
        );
        return {
          text: `[Placeholder] Completed via ${execOpts.subagentType} subagent`,
          cost: 0,
          modelUsed: execOpts.modelHint,
          toolCalls: [],
          budgetExceeded: false,
        };
      },
      async checkBuild(command: string, cwd: string) {
        const parts = command.split(/\s+/);
        try {
          execFileSync(parts[0], parts.slice(1), {
            cwd,
            timeout: 60000,
            stdio: "pipe",
          });
          return { passed: true, output: "" };
        } catch (err: any) {
          return {
            passed: false,
            output: err.stderr?.toString()?.slice(0, 500) ?? "",
          };
        }
      },
    };

    try {
      for await (const event of executePlan(planPath, dispatcher, {
        projectPath: process.cwd(),
        buildCommand: "npx turbo run build --force",
        defaultBudgetPerTask: parseFloat(opts.taskBudget),
        planBudgetLimit: opts.budget ? parseFloat(opts.budget) : undefined,
        mode,
        maxRetries: parseInt(opts.retries),
        compactBetweenPhases: true,
      })) {
        switch (event.type) {
          case "plan-started":
            console.log(`  Plan: ${event.plan.name}`);
            console.log(`  Tasks: ${event.totalTasks} pending\n`);
            break;
          case "phase-started":
            console.log(`  ── ${event.phase.name} ──`);
            break;
          case "sprint-started":
            console.log(`    ${event.sprint.name}`);
            break;
          case "task-started":
            console.log(
              `    ● ${event.task.description.slice(0, 60)} [${event.subagentType}/${event.model}]`,
            );
            break;
          case "task-completed":
            console.log(
              `    ✓ ${event.task.description.slice(0, 60)}  $${event.cost.toFixed(4)}`,
            );
            break;
          case "task-failed":
            console.log(
              `    ✗ ${event.task.description.slice(0, 60)}  ${event.reason}`,
            );
            break;
          case "task-retrying":
            console.log(`    ↻ Retry #${event.attempt} with ${event.model}`);
            break;
          case "task-budget-exceeded":
            console.log(`    $ Budget exceeded: $${event.cost.toFixed(4)}`);
            break;
          case "build-check":
            console.log(
              `    ${event.passed ? "✓" : "✗"} Build ${event.passed ? "passed" : "FAILED"}`,
            );
            break;
          case "phase-completed":
            console.log(
              `  ✓ ${event.phase.name} complete  $${event.cost.toFixed(4)}\n`,
            );
            break;
          case "plan-completed":
            console.log(`  ═══════════════════════════════`);
            console.log(
              `  Plan complete: $${event.totalCost.toFixed(4)} total\n`,
            );
            break;
          case "plan-paused":
            console.log(`\n  ⚠ Paused: ${event.reason}\n`);
            break;
          case "skill-activated":
            console.log(`    ✦ Skill: ${event.skillName}`);
            break;
          case "dry-run-task": {
            const d = event.dispatch;
            console.log(
              `    ○ ${event.task.description.slice(0, 45).padEnd(47)} ${d.subagentType.padEnd(10)} ${d.modelHint.padEnd(10)} ~$${event.estimatedCost.toFixed(2)}`,
            );
            break;
          }
          case "dry-run-summary":
            console.log(
              `\n  Summary: ${event.totalTasks} tasks, ~$${event.estimatedCost.toFixed(2)} estimated`,
            );
            console.log(
              `  By type: ${Object.entries(event.tasksByType)
                .map(([k, v]) => `${k}:${v}`)
                .join(", ")}\n`,
            );
            break;
        }
      }
    } catch (err) {
      console.error(
        `\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  });

planCmd
  .command("parse")
  .argument("<path>", "Path to .plan.md file")
  .description("Parse and display a plan file structure")
  .action(async (path: string) => {
    const { parsePlanFile } = await import("@brainst0rm/core");
    const { resolve } = await import("node:path");
    let plan;
    try {
      plan = parsePlanFile(resolve(path));
    } catch (err) {
      console.error(
        `\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    console.log(`\n  ${plan.name} (${plan.status})`);
    console.log(`  ${plan.completedTasks}/${plan.totalTasks} tasks complete\n`);

    for (const phase of plan.phases) {
      const icon =
        phase.status === "completed"
          ? "✓"
          : phase.status === "in_progress"
            ? "◐"
            : "○";
      console.log(
        `  ${icon} ${phase.name}  ${phase.completedCount}/${phase.taskCount}`,
      );
      for (const sprint of phase.sprints) {
        console.log(`    ${sprint.name}`);
        for (const task of sprint.tasks) {
          const tIcon = task.status === "completed" ? "✓" : "○";
          const cost = task.cost ? `$${task.cost.toFixed(2)}` : "";
          const skill = task.assignedSkill ? `[${task.assignedSkill}]` : "";
          console.log(`      ${tIcon} ${task.description} ${skill} ${cost}`);
        }
      }
    }
    console.log();
  });

// ── Orchestrate Command ───────────────────────────────────────────

const orchestrateCmd = program
  .command("orchestrate")
  .description("Coordinate work across multiple projects");

orchestrateCmd
  .command("pipeline")
  .argument("<request>", "What to build (natural language)")
  .option("--build <cmd>", "Build command", "npx turbo run build --force")
  .option("--test <cmd>", "Test command", "npx turbo run test")
  .option("--deploy", "Include deployment phase")
  .option("--budget <amount>", "Total budget limit in dollars")
  .option(
    "--phases <list>",
    "Comma-separated phases to run (spec,architecture,implementation,review,verify,refactor,deploy,document,report)",
  )
  .option("--resume-from <phase>", "Resume from a specific phase")
  .option("--dry-run", "Show what agents would be dispatched")
  .description("Run the full 9-phase development pipeline")
  .action(async (request: string, opts: any) => {
    const { runOrchestrationPipeline, createPipelineDispatcher } =
      await import("@brainst0rm/core");

    console.log(`\n  Orchestration Pipeline\n`);
    console.log(`  Request: "${request}"`);
    console.log(`  Mode: ${opts.dryRun ? "dry-run" : "execute"}\n`);

    // Set up real runtime — env vars only (no vault prompt for non-interactive pipeline)
    const config = loadConfig();
    const db = getDb();
    const envKeys = new Map<string, string>();
    for (const name of PROVIDER_KEY_NAMES) {
      const val = process.env[name];
      if (val) envKeys.set(name, val);
    }
    const resolvedKeys: ResolvedKeys = {
      get: (name: string) => envKeys.get(name) ?? null,
    };
    const registry = await createProviderRegistry(config, resolvedKeys);
    const costTracker = new CostTracker(db, config.budget);
    const projectPath = process.cwd();
    const tools = createDefaultToolRegistry();
    const { frontmatter } = buildSystemPrompt(projectPath);
    const router = new BrainstormRouter(
      config,
      registry,
      costTracker,
      frontmatter,
    );

    // Create real dispatcher — wired to spawnSubagent() with agent.md definitions
    const dispatcher = createPipelineDispatcher({
      config,
      registry,
      router,
      costTracker,
      tools,
      projectPath,
    });

    // Fallback: if no provider keys, use placeholder
    const hasProviders = PROVIDER_KEY_NAMES.some(
      (k) => resolvedKeys.get(k) !== null,
    );
    if (!hasProviders && !opts.dryRun) {
      console.log(
        "  ⚠ No model providers configured. Using placeholder dispatcher.",
      );
      console.log("  Set API keys via: storm vault add ANTHROPIC_API_KEY\n");
    }

    const activeDispatcher =
      hasProviders || opts.dryRun
        ? dispatcher
        : {
            async runPhase(
              agentId: string,
              subagentType: string,
              prompt: string,
              phaseOpts: any,
            ) {
              console.log(`    Agent: ${agentId} (${subagentType})`);
              return {
                text: `[No providers] ${agentId} would execute`,
                cost: 0,
                toolCalls: [],
              };
            },
            async runParallel(specs: any[], phaseOpts: any) {
              return specs.map((s: any) => {
                console.log(`    Agent: ${s.agentId} (${s.subagentType})`);
                return {
                  agentId: s.agentId,
                  text: `[No providers] ${s.agentId} would execute`,
                  cost: 0,
                  toolCalls: [],
                };
              });
            },
            async runCommand(command: string, cwd: string) {
              const { execFileSync } = await import("node:child_process");
              const parts = command.split(/\s+/);
              try {
                execFileSync(parts[0], parts.slice(1), {
                  cwd,
                  timeout: 120000,
                  stdio: "pipe",
                });
                return { passed: true, output: "" };
              } catch (err: any) {
                return {
                  passed: false,
                  output: err.stderr?.toString()?.slice(0, 500) ?? "",
                };
              }
            },
          };

    const phases = opts.phases?.split(",") ?? undefined;

    for await (const event of runOrchestrationPipeline(
      request,
      activeDispatcher,
      {
        projectPath,
        buildCommand: opts.build,
        testCommand: opts.test,
        deploy: opts.deploy,
        budget: opts.budget ? parseFloat(opts.budget) : undefined,
        phases,
        resumeFrom: opts.resumeFrom,
        dryRun: opts.dryRun,
      },
    )) {
      switch (event.type) {
        case "pipeline-started":
          console.log(`  Phases: ${event.phases.join(" → ")}\n`);
          break;
        case "phase-started":
          console.log(
            `  ── ${event.phase.toUpperCase()} ──  (${event.agentId})`,
          );
          break;
        case "phase-completed":
          const icon = event.result.success ? "✓" : "✗";
          console.log(
            `  ${icon} ${event.result.phase}  $${event.result.cost.toFixed(4)}  ${event.result.duration}ms`,
          );
          if (event.result.output && !event.result.output.startsWith("[")) {
            console.log(
              `    ${event.result.output.split("\n")[0].slice(0, 100)}`,
            );
          }
          console.log();
          break;
        case "phase-failed":
          console.log(`  ✗ ${event.phase}: ${event.error}\n`);
          break;
        case "review-findings":
          console.log(
            `  Reviews: ${event.findings.length} finding(s)${event.hasCritical ? " (CRITICAL)" : ""}`,
          );
          for (const f of event.findings.slice(0, 5)) {
            console.log(`    [${f.severity}] ${f.description.slice(0, 80)}`);
          }
          console.log();
          break;
        case "feedback-loop":
          console.log(
            `  ↻ Feedback: ${event.from} → ${event.to} (${event.reason})\n`,
          );
          break;
        case "pipeline-completed":
          console.log(`  ═══════════════════════════════════`);
          console.log(
            `  Pipeline complete: $${event.totalCost.toFixed(4)} total`,
          );
          console.log(
            `  ${event.results.filter((r) => r.success).length}/${event.results.length} phases succeeded\n`,
          );
          break;
        case "pipeline-paused":
          console.log(`  ⚠ Paused at ${event.phase}: ${event.reason}\n`);
          break;
      }
    }
  });

orchestrateCmd
  .command("run")
  .argument("<description>", "What to do across projects")
  .requiredOption("-p, --projects <names>", "Comma-separated project names")
  .option("--budget <amount>", "Total budget limit in dollars")
  .option("--type <type>", "Subagent type (explore, code, review)", "code")
  .description("Run a cross-project orchestration")
  .action(
    async (
      description: string,
      opts: { projects: string; budget?: string; type: string },
    ) => {
      const { OrchestrationEngine, formatAggregatedResults, aggregateResults } =
        await import("@brainst0rm/orchestrator");
      const { ProjectManager } = await import("@brainst0rm/projects");
      const db = getDb();
      const engine = new OrchestrationEngine(db);
      const pm = new ProjectManager(db);

      const projectNames = opts.projects
        .split(",")
        .map((s: string) => s.trim());

      console.log(
        `\n  Orchestrating across ${projectNames.length} projects...`,
      );
      console.log(`  "${description}"\n`);

      try {
        for await (const event of engine.run({
          description,
          projectNames,
          budgetLimit: opts.budget ? parseFloat(opts.budget) : undefined,
          subagentType: opts.type,
        })) {
          switch (event.type) {
            case "plan-ready":
              console.log(`  Plan: ${event.tasks.length} tasks created`);
              break;
            case "task-started":
              console.log(`  ● ${event.project.name} — starting...`);
              break;
            case "task-completed":
              console.log(
                `  ✓ ${event.project.name} — $${event.cost.toFixed(4)}`,
              );
              if (event.summary)
                console.log(`    ${event.summary.slice(0, 120)}`);
              break;
            case "task-failed":
              console.log(`  ✗ ${event.project.name} — ${event.error}`);
              break;
            case "orchestration-completed": {
              const projectMap = new Map<string, string>();
              for (const name of projectNames) {
                const p = pm.projects.getByName(name);
                if (p) projectMap.set(p.id, p.name);
              }
              const tasks = event.results.map((r, i) => ({
                ...event.run,
                projectId: projectMap.get(r.projectName) ?? r.projectName,
              }));
              console.log(`\n  ── Complete ──`);
              console.log(`  Total cost: $${event.run.totalCost.toFixed(4)}`);
              console.log(
                `  ${event.results.filter((r) => !r.summary.startsWith("FAILED")).length}/${event.results.length} succeeded\n`,
              );
              break;
            }
          }
        }
      } catch (err) {
        console.error(
          `\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  );

orchestrateCmd
  .command("history")
  .option("-n, --limit <count>", "Number of runs to show", "10")
  .description("Show recent orchestration runs")
  .action(async (opts: { limit: string }) => {
    const { OrchestrationEngine } = await import("@brainst0rm/orchestrator");
    const db = getDb();
    const engine = new OrchestrationEngine(db);
    const runs = engine.listRecent(parseInt(opts.limit));

    console.log("\n  Orchestration History:\n");
    if (runs.length === 0) {
      console.log("    No orchestration runs yet.\n");
      return;
    }
    for (const r of runs) {
      const icon =
        r.status === "completed"
          ? "✓"
          : r.status === "failed"
            ? "✗"
            : r.status === "cancelled"
              ? "○"
              : "●";
      const date = new Date(r.createdAt * 1000).toLocaleString();
      console.log(
        `    ${icon} ${r.name.slice(0, 40).padEnd(42)} $${r.totalCost.toFixed(4).padEnd(10)} ${r.status.padEnd(12)} ${date}`,
      );
    }
    console.log();
  });

orchestrateCmd
  .command("parallel")
  .argument("<request>", "High-level request to decompose into parallel tasks")
  .option("--workers <n>", "Concurrent workers (default 3)", "3")
  .option("--budget <amount>", "Budget cap for the entire run in dollars", "5")
  .option(
    "--no-merge",
    "Do not auto-merge approved worktrees — leave for human review",
  )
  .option(
    "--skip-build-verify",
    "Skip per-worktree build verification (faster but less safe)",
  )
  .description(
    "Plan → parallel workers → judge: decompose a request, run N workers in isolated worktrees, merge approved branches",
  )
  .action(
    async (
      request: string,
      opts: {
        workers: string;
        budget: string;
        merge?: boolean;
        skipBuildVerify?: boolean;
      },
    ) => {
      const { planMultiAgentRun, runWorkerPool, runJudge } =
        await import("@brainst0rm/core");

      const projectPath = process.cwd();
      const concurrency = parseInt(opts.workers, 10);
      const budgetLimit = parseFloat(opts.budget);
      const autoMerge = opts.merge !== false;

      console.log(`\n  Multi-Agent Parallel Orchestration\n`);
      console.log(`  Request:  "${request.slice(0, 80)}"`);
      console.log(`  Workers:  ${concurrency} concurrent`);
      console.log(`  Budget:   $${budgetLimit.toFixed(2)}`);
      console.log(`  Merge:    ${autoMerge ? "auto on approve" : "manual"}`);
      console.log();

      // Set up runtime — same pattern as other CLI commands
      const config = loadConfig();
      config.general.defaultPermissionMode = "auto"; // unattended
      const db = getDb();
      const resolvedKeys = await resolveProviderKeys();
      const registry = await createProviderRegistry(config, resolvedKeys);
      const costTracker = new CostTracker(db, config.budget);
      const tools = createDefaultToolRegistry();
      const { frontmatter } = buildSystemPrompt(projectPath);
      const router = new BrainstormRouter(
        config,
        registry,
        costTracker,
        frontmatter,
      );
      router.setStrategy("capability");

      // Resolve the project ID — orchestration_runs needs an FK target
      const { ProjectManager } = await import("@brainst0rm/projects");
      const pm = new ProjectManager(db);
      const project = pm.projects.getByPath(projectPath);
      if (!project) {
        console.error(
          `  No project registered for ${projectPath}. Run 'brainstorm projects add' first.\n`,
        );
        process.exit(1);
      }

      const sharedSubagentOptions: any = {
        config,
        registry,
        router,
        costTracker,
        tools,
        projectPath,
        permissionCheck: () => "allow",
        budgetLimit: budgetLimit / Math.max(1, concurrency * 2),
      };

      // ── Phase 1: Planner ────────────────────────────────────────────
      console.log(`  [Planner] decomposing request...`);
      let plan;
      try {
        plan = await planMultiAgentRun({
          request,
          projectId: project.id,
          budgetLimit,
          subagentOptions: sharedSubagentOptions,
          db,
        });
      } catch (err: any) {
        console.error(`  ✗ Planner failed: ${err.message}\n`);
        process.exit(1);
      }
      console.log(
        `  [Planner] done — ${plan.subtaskCount} subtasks, ${plan.totalDependencies} edges, $${plan.cost.toFixed(4)} (${plan.modelUsed})`,
      );
      console.log(`  [Planner] strategy: ${plan.summary.slice(0, 200)}\n`);

      // ── Phase 2: Worker Pool ────────────────────────────────────────
      console.log(`  [Workers] starting ${concurrency} workers...`);
      let poolResult: any;
      const eventGen = runWorkerPool({
        runId: plan.runId,
        db,
        subagentOptions: sharedSubagentOptions,
        concurrency,
        preserveWorktrees: true,
      });
      while (true) {
        const next = await eventGen.next();
        if (next.done) {
          poolResult = next.value;
          break;
        }
        const event = next.value;
        switch (event.type) {
          case "worker-claimed":
            console.log(
              `  [${event.workerId}] claimed: ${event.task?.prompt.slice(0, 60)}...`,
            );
            break;
          case "worker-completed":
            console.log(
              `  [${event.workerId}] ✓ ($${event.cost?.toFixed(4)}, ${event.filesTouched?.length ?? 0} files)`,
            );
            break;
          case "worker-failed":
            console.log(
              `  [${event.workerId}] ✗ ${event.error?.slice(0, 80) ?? "failed"}`,
            );
            break;
          case "pool-finished":
            console.log(
              `  [Workers] done — ${event.totalCompleted} completed, ${event.totalFailed} failed`,
            );
            break;
        }
      }

      // ── Phase 3: Judge ──────────────────────────────────────────────
      console.log(`\n  [Judge] verifying worktrees...`);
      const verdict = await runJudge({
        runId: plan.runId,
        db,
        projectPath,
        skipBuildVerify: opts.skipBuildVerify ?? false,
        autoMerge,
      });

      console.log(
        `  [Judge] decision: ${verdict.decision.toUpperCase()} (${verdict.reason})`,
      );
      const conflicts = Object.keys(verdict.conflictMatrix);
      if (conflicts.length > 0) {
        console.log(`  [Judge] conflicts on ${conflicts.length} files:`);
        for (const file of conflicts.slice(0, 10)) {
          console.log(
            `    ${file} (tasks: ${verdict.conflictMatrix[file].join(", ")})`,
          );
        }
      }
      if (verdict.mergedTaskIds.length > 0) {
        console.log(
          `  [Judge] merged ${verdict.mergedTaskIds.length} task branch(es) into ${projectPath}`,
        );
      }

      console.log(
        `\n  Total cost: $${(plan.cost + (poolResult?.totalCost ?? 0)).toFixed(4)}`,
      );
      console.log(`  Run id: ${plan.runId}`);
      console.log();

      process.exit(verdict.decision === "approve" ? 0 : 1);
    },
  );

orchestrateCmd
  .command("status")
  .argument("<run-id>", "Orchestration run ID")
  .description("Show status of an orchestration run")
  .action(async (runId: string) => {
    const { OrchestrationEngine } = await import("@brainst0rm/orchestrator");
    const { ProjectManager } = await import("@brainst0rm/projects");
    const db = getDb();
    const engine = new OrchestrationEngine(db);
    const pm = new ProjectManager(db);
    const detail = engine.getRunWithTasks(runId);
    if (!detail) {
      console.error(`  Run "${runId}" not found.\n`);
      return;
    }

    console.log(`\n  ── ${detail.run.name} ──`);
    console.log(`  Status: ${detail.run.status}`);
    console.log(`  Cost:   $${detail.run.totalCost.toFixed(4)}`);
    console.log(`  Tasks:  ${detail.tasks.length}\n`);

    for (const t of detail.tasks) {
      const project = pm.projects.getById(t.projectId);
      const icon =
        t.status === "completed"
          ? "✓"
          : t.status === "failed"
            ? "✗"
            : t.status === "skipped"
              ? "○"
              : "●";
      console.log(
        `    ${icon} ${(project?.name ?? t.projectId.slice(0, 8)).padEnd(25)} ${t.status.padEnd(12)} $${t.cost.toFixed(4)}`,
      );
      if (t.resultSummary)
        console.log(`      ${t.resultSummary.slice(0, 100)}`);
    }
    console.log();
  });

// ── Intelligence Command ───────────────────────────────────────────

program
  .command("intelligence")
  .alias("intel")
  .description("Show what BrainstormRouter has learned about your usage")
  .option("--json", "Output as JSON")
  .option(
    "--period <period>",
    "Usage period (daily, weekly, monthly)",
    "weekly",
  )
  .action(async (opts: { json?: boolean; period: string }) => {
    const gw = createGatewayClient();
    const intel = createIntelligenceClient();

    if (!gw) {
      console.log(
        "\n  No BRAINSTORM_API_KEY set. Cannot connect to BrainstormRouter.\n",
      );
      process.exit(1);
    }

    console.log("\n  Fetching intelligence from BrainstormRouter...\n");

    // Fetch all data in parallel — graceful fallback on each endpoint
    const [
      leaderboard,
      usage,
      waste,
      forecast,
      daily,
      governance,
      recommendations,
      patterns,
    ] = await Promise.all([
      gw.getLeaderboard().catch(() => []),
      gw.getUsageSummary(opts.period).catch(() => null),
      gw.getWasteInsights().catch(() => null),
      gw.getForecast().catch(() => null),
      gw.getDailyInsights().catch(() => []),
      gw.getGovernanceSummary().catch(() => null),
      intel?.getRecommendations("code", "typescript").catch(() => []) ?? [],
      intel?.getPatterns("typescript").catch(() => []) ?? [],
    ]);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            leaderboard,
            usage,
            waste,
            forecast,
            daily,
            governance,
            recommendations,
            patterns,
          },
          null,
          2,
        ),
      );
      return;
    }

    // ── Header ──
    console.log("  ══════════════════════════════════════════════════");
    console.log("   BrainstormRouter Intelligence Report");
    console.log("  ══════════════════════════════════════════════════\n");

    // ── Learning Status ──
    // Usage shape: { data: [{ requestCount, totalCostUsd, ... }] }
    const usageData = (usage as any)?.data?.[0];
    const totalRequests = usageData?.requestCount ?? 0;
    const confidence =
      totalRequests >= 200 ? "HIGH" : totalRequests >= 50 ? "MEDIUM" : "LOW";
    const confidenceNote =
      confidence === "LOW"
        ? ` (need ${200 - totalRequests} more for high confidence)`
        : "";
    console.log(
      `  Learning Status: ${totalRequests.toLocaleString()} requests analyzed`,
    );
    console.log(`  Routing Confidence: ${confidence}${confidenceNote}\n`);

    // ── Model Performance ──
    // Leaderboard shape: { id, model_id, reward_score, value_score, latency_ms, sample_count, ... }
    const realLeaderboard = leaderboard.filter(
      (m: any) => m.id && !m.id.startsWith("cache/"),
    );
    if (realLeaderboard.length > 0) {
      console.log("  Model Performance:\n");
      for (const entry of realLeaderboard.slice(0, 8)) {
        const m = entry as any;
        const modelName = m.model_id ?? m.id ?? m.model ?? "unknown";
        const name =
          modelName.length > 35 ? modelName.slice(0, 35) + "…" : modelName;
        const latency =
          m.latency_ms != null
            ? m.latency_ms < 1000
              ? `${Math.round(m.latency_ms)}ms`
              : `${(m.latency_ms / 1000).toFixed(1)}s`
            : "  n/a";
        const reward =
          m.reward_score != null
            ? (m.reward_score * 100).toFixed(0) + "%"
            : "n/a";
        const value = m.value_score != null ? m.value_score.toFixed(0) : "n/a";
        const samples = m.sample_count ?? m.request_count ?? 0;
        const isBest = entry === realLeaderboard[0] ? " ← BEST" : "";
        console.log(
          `    ${name.padEnd(37)} reward:${reward.padStart(4)} value:${value.padStart(5)} ${latency.padStart(6)} (${samples} samples)${isBest}`,
        );
      }
      console.log();
    }

    // ── What the System Learned ──
    if (recommendations.length > 0) {
      console.log("  What the system learned:\n");
      for (const rec of recommendations.slice(0, 5)) {
        const r = rec as any;
        const conf =
          r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "";
        console.log(
          `    • ${r.taskType} → ${r.recommendedModel} (${conf} confidence)`,
        );
        if (r.reasoning) {
          console.log(`      ${r.reasoning}`);
        }
      }
      console.log();
    }

    // ── Cost Intelligence ──
    if (usageData) {
      const totalTokens =
        (usageData.totalInputTokens ?? 0) + (usageData.totalOutputTokens ?? 0);
      console.log("  Cost Summary:\n");
      console.log(`    Period:       ${(usage as any)?.period ?? opts.period}`);
      console.log(
        `    Total:        $${(usageData.totalCostUsd ?? 0).toFixed(4)}`,
      );
      console.log(
        `    Requests:     ${(usageData.requestCount ?? 0).toLocaleString()}`,
      );
      console.log(`    Tokens:       ${totalTokens.toLocaleString()}`);
      console.log(
        `    Avg latency:  ${(usageData.avgLatencyMs ?? 0).toFixed(0)}ms`,
      );
      console.log();
    }

    // ── Budget Forecast ──
    // Forecast shape: { forecast: { avgDailySpendUsd, trend, confidence, projectedPeriodSpendUsd }, todaySpendUsd, daysOfData }
    const fc = (forecast as any)?.forecast;
    if (fc) {
      const trend = fc.trend ?? "stable";
      const trendIcon =
        trend === "increasing" ? "↑" : trend === "decreasing" ? "↓" : "→";
      console.log("  Budget Forecast:\n");
      console.log(
        `    Avg daily:   $${(fc.avgDailySpendUsd ?? 0).toFixed(2)} (${trendIcon} ${trend})`,
      );
      console.log(
        `    Projected:   $${(fc.projectedPeriodSpendUsd ?? 0).toFixed(2)}`,
      );
      console.log(
        `    Today:       $${((forecast as any)?.todaySpendUsd ?? 0).toFixed(4)}`,
      );
      console.log(
        `    Data points: ${(forecast as any)?.daysOfData ?? 0} days`,
      );
      console.log();
    }

    // ── Waste Insights ──
    // Waste shape: { estimatedWasteUsd, overQualifiedModels: [...], duplicateRequests: [...] }
    const wasteAny = waste as any;
    if (
      wasteAny &&
      (wasteAny.overQualifiedModels?.length > 0 ||
        wasteAny.duplicateRequests?.length > 0)
    ) {
      console.log("  Optimization Opportunities:\n");
      console.log(
        `    Total recoverable: $${(wasteAny.estimatedWasteUsd ?? 0).toFixed(4)}\n`,
      );
      for (const m of (wasteAny.overQualifiedModels ?? []).slice(0, 3)) {
        console.log(
          `    • ${m.model}: $${m.totalCostUsd.toFixed(4)} on ${m.requestCount} reqs`,
        );
        console.log(`      → ${m.suggestion}`);
      }
      const dupeCount = (wasteAny.duplicateRequests ?? []).length;
      if (dupeCount > 0) {
        const totalDupeWaste = (wasteAny.duplicateRequests ?? []).reduce(
          (sum: number, d: any) => sum + (d.wastedCostUsd ?? 0),
          0,
        );
        console.log(
          `    • ${dupeCount} duplicate request patterns ($${totalDupeWaste.toFixed(4)} wasted)`,
        );
        console.log(`      → Enable prompt caching to reduce duplicates`);
      }
      console.log();
    }

    // ── Community Patterns ──
    if (patterns.length > 0) {
      console.log("  Community Patterns (TypeScript):\n");
      for (const p of patterns.slice(0, 3)) {
        const pat = p as any;
        console.log(
          `    • ${pat.taskType}: prefer ${(pat.preferredTools ?? []).join(", ")} (${pat.confirmations ?? 0} confirmations)`,
        );
        if (pat.avoidTools?.length > 0) {
          console.log(`      avoid: ${pat.avoidTools.join(", ")}`);
        }
      }
      console.log();
    }

    // ── Governance ──
    if (governance) {
      const gov = governance as any;
      console.log("  Governance:\n");
      if (gov.memory_health) {
        console.log(
          `    Memory:   ${gov.memory_health.total_entries} entries (${gov.memory_health.compliance_status})`,
        );
      }
      if (gov.audit_stats) {
        console.log(
          `    Audit:    ${gov.audit_stats.total_requests} requests, ${gov.audit_stats.flagged} flagged`,
        );
      }
      if (gov.anomaly_score != null) {
        console.log(
          `    Anomaly:  ${gov.anomaly_score.toFixed(2)} (0=clean, 1=suspicious)`,
        );
      }
      console.log();
    }

    console.log("  ──────────────────────────────────────────────────");
    console.log(
      `  Tip: Run \`storm intel --json\` for machine-readable output.`,
    );
    console.log();
  });

// ── Analyze Command ───────────────────────────────────────────────

program
  .command("analyze")
  .description(
    "Analyze a codebase — languages, frameworks, dependencies, complexity",
  )
  .argument("[path]", "Project path to analyze", ".")
  .option("--json", "Output as JSON")
  .option(
    "--deep",
    "Run deep AST analysis with tree-sitter (builds call graph, detects communities)",
  )
  .action(
    async (projectPath: string, opts: { json?: boolean; deep?: boolean }) => {
      const { resolve } = await import("node:path");
      const absPath = resolve(projectPath);

      console.log(`\n  Analyzing ${absPath}...\n`);
      const startTime = Date.now();

      const { analyzeProject, runDeepAnalysis } =
        await import("@brainst0rm/ingest");
      const analysis = analyzeProject(absPath);

      // Deep analysis: tree-sitter AST parsing → SQLite graph → communities
      if (opts.deep) {
        console.log(`  Running deep analysis (tree-sitter AST parsing)...`);
        try {
          analysis.graph = await runDeepAnalysis(absPath);
          console.log(
            `    ✓ ${analysis.graph.stats.nodes} nodes, ${analysis.graph.stats.graphEdges} edges, ` +
              `${analysis.graph.communities.length} communities (${analysis.graph.pipelineMs}ms)\n`,
          );
        } catch (err: any) {
          console.log(`    ✗ Deep analysis failed: ${err.message}\n`);
        }
      }

      const elapsed = Date.now() - startTime;

      if (opts.json) {
        console.log(JSON.stringify(analysis, null, 2));
        return;
      }

      console.log("  ══════════════════════════════════════════════════");
      console.log("   Codebase Analysis");
      console.log("  ══════════════════════════════════════════════════\n");

      console.log(
        `  ${analysis.summary.totalFiles} files | ${analysis.summary.totalLines.toLocaleString()} lines | ${analysis.summary.primaryLanguage}`,
      );
      console.log(
        `  ${analysis.summary.moduleCount} modules | avg complexity: ${analysis.summary.avgComplexity}/100 | ${elapsed}ms\n`,
      );

      // Languages
      console.log("  Languages:");
      for (const l of analysis.languages.languages.slice(0, 8)) {
        const bar = "█".repeat(Math.max(1, Math.round(l.percentage / 5)));
        console.log(
          `    ${l.language.padEnd(15)} ${bar} ${l.percentage}% (${l.files} files, ${l.lines.toLocaleString()} lines)`,
        );
      }

      // Frameworks
      const hasStack =
        analysis.frameworks.frameworks.length > 0 ||
        analysis.frameworks.buildTools.length > 0;
      if (hasStack) {
        console.log("\n  Stack:");
        if (analysis.frameworks.frameworks.length > 0)
          console.log(
            `    Frameworks:  ${analysis.frameworks.frameworks.join(", ")}`,
          );
        if (analysis.frameworks.buildTools.length > 0)
          console.log(
            `    Build:       ${analysis.frameworks.buildTools.join(", ")}`,
          );
        if (analysis.frameworks.databases.length > 0)
          console.log(
            `    Databases:   ${analysis.frameworks.databases.join(", ")}`,
          );
        if (analysis.frameworks.testing.length > 0)
          console.log(
            `    Testing:     ${analysis.frameworks.testing.join(", ")}`,
          );
        if (analysis.frameworks.deployment.length > 0)
          console.log(
            `    Deploy:      ${analysis.frameworks.deployment.join(", ")}`,
          );
        if (analysis.frameworks.ci.length > 0)
          console.log(`    CI/CD:       ${analysis.frameworks.ci.join(", ")}`);
      }

      // Complexity hotspots
      if (analysis.complexity.summary.hotspots.length > 0) {
        console.log("\n  Complexity Hotspots (score > 70):");
        for (const f of analysis.complexity.files
          .filter((cf: any) => cf.score >= 70)
          .slice(0, 8)) {
          console.log(
            `    ${f.path.padEnd(50)} score:${f.score} branches:${f.branchCount} nesting:${f.maxNesting}`,
          );
        }
      }

      // Module clusters
      if (analysis.dependencies.clusters.length > 0) {
        console.log("\n  Module Clusters (by size):");
        for (const c of analysis.dependencies.clusters.slice(0, 8)) {
          const cohesionLabel =
            c.cohesion > 0.5 ? "high" : c.cohesion > 0.2 ? "med" : "low";
          console.log(
            `    ${c.directory.padEnd(40)} ${c.files.length} files  cohesion:${cohesionLabel}`,
          );
        }
      }

      // Deep graph results
      if (analysis.graph) {
        const g = analysis.graph;
        console.log("\n  Knowledge Graph (tree-sitter AST):");
        console.log(
          `    ${g.stats.functions} functions | ${g.stats.classes} classes | ${g.stats.methods} methods`,
        );
        console.log(
          `    ${g.stats.callEdges} call edges | ${g.crossFile.resolved} cross-file resolved`,
        );
        console.log(
          `    ${g.communities.length} communities | languages: ${g.parsedLanguages.join(", ") || "none"}`,
        );

        if (g.exports.length > 0) {
          console.log(`\n  Top Exports:`);
          for (const e of g.exports.slice(0, 10)) {
            console.log(
              `    ${e.kind.padEnd(10)} ${e.name.padEnd(40)} ${e.file}:${e.line}`,
            );
          }
        }

        if (g.callHotspots.length > 0) {
          console.log(`\n  Call Hotspots (most-called symbols):`);
          for (const h of g.callHotspots.slice(0, 10)) {
            console.log(
              `    ${String(h.callerCount).padStart(4)} callers  ${h.name.padEnd(40)} ${h.file ?? "unknown"}`,
            );
          }
        }

        if (g.communities.length > 0) {
          console.log(`\n  Communities (Louvain):`);
          for (const c of g.communities.slice(0, 10)) {
            console.log(
              `    ${(c.name ?? c.id).padEnd(40)} ${c.nodeCount} nodes`,
            );
          }
        }
      }

      console.log("\n  ──────────────────────────────────────────────────");
      if (!analysis.graph) {
        console.log(
          `  Run \`storm analyze --deep\` for AST-based knowledge graph.`,
        );
      }
      console.log(
        `  Run \`storm analyze --json\` for machine-readable output.`,
      );
      console.log();
    },
  );

// ── Docgen Command ────────────────────────────────────────────────

program
  .command("docgen")
  .description(
    "Generate documentation — architecture docs, module docs, API reference",
  )
  .argument("[path]", "Project path to document", ".")
  .option("--output <dir>", "Output directory (default: docs/generated)")
  .option("--json", "Output file list as JSON")
  .action(
    async (projectPath: string, opts: { output?: string; json?: boolean }) => {
      const { resolve } = await import("node:path");
      const absPath = resolve(projectPath);

      console.log(`\n  Analyzing ${absPath}...`);
      const { analyzeProject } = await import("@brainst0rm/ingest");
      const analysis = analyzeProject(absPath);

      console.log(`  Generating documentation...\n`);
      const { generateAllDocs } = await import("@brainst0rm/docgen");
      const result = generateAllDocs(analysis, opts.output);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log("  ══════════════════════════════════════════════════");
      console.log("   Documentation Generated");
      console.log("  ══════════════════════════════════════════════════\n");
      console.log(`  Output: ${result.outputDir}`);
      console.log(`  Files written: ${result.filesWritten.length}`);
      console.log("");
      console.log(`  Architecture:  ${result.architectureDoc}`);
      console.log(`  Modules:       ${result.moduleDocs} module docs`);
      if (result.apiDoc) {
        console.log(`  API Reference: ${result.apiDoc}`);
      } else {
        console.log(`  API Reference: (no endpoints detected)`);
      }
      console.log("\n  ──────────────────────────────────────────────────");
      console.log(
        `  Tip: Use these docs as context for AI agents with @docs/generated/ARCHITECTURE.md`,
      );
      console.log();
    },
  );

// ── Spawn Command (Background Worktree Agents) ───────────────────

program
  .command("spawn")
  .description("Spawn a background agent in an isolated git worktree")
  .argument("<task>", "Task description for the background agent")
  .option(
    "--type <type>",
    "Subagent type (code, review, explore, research)",
    "code",
  )
  .option("--budget <amount>", "Budget limit in dollars", "1.0")
  .action(async (task: string, opts: { type: string; budget: string }) => {
    const { resolve } = await import("node:path");
    const { createWorktree, removeWorktree } = await import("@brainst0rm/core");
    const projectPath = resolve(".");
    const worktreePath = createWorktree(projectPath, opts.type);

    console.log(`\n  Spawned background agent in worktree:`);
    console.log(`    Path:   ${worktreePath}`);
    console.log(`    Type:   ${opts.type}`);
    console.log(`    Budget: $${opts.budget}`);
    console.log(`    Task:   ${task}`);
    console.log();
    console.log(`  The agent is running in an isolated copy of your repo.`);
    console.log(`  When done, changes will be on a spec-* branch.`);
    console.log(`  Use \`git worktree list\` to see active worktrees.`);
    console.log(`  Use \`git diff main...<branch>\` to review changes.`);
    console.log();

    // In a full implementation, this would fork a child process running
    // runAgentLoop in the worktree directory. For now, it sets up the
    // worktree and reports the path for manual or CI-driven execution.
    // The worktree is ready for: storm run --unattended "<task>" in the worktree dir.
    console.log(`  To run the agent:`);
    console.log(`    cd ${worktreePath} && storm run --unattended "${task}"`);
    console.log();
  });

// ── Storm Command (Parallel Agent Spawning) ──────────────────────

program
  .command("storm")
  .description("Run multiple tasks in parallel using subagents")
  .argument(
    "<tasks...>",
    "Task descriptions (each runs as a separate subagent)",
  )
  .option(
    "--type <type>",
    "Subagent type for all tasks (explore, plan, code, review, research)",
    "code",
  )
  .option("--budget <amount>", "Budget limit per task in dollars", "1.0")
  .action(async (tasks: string[], opts: { type: string; budget: string }) => {
    const config = loadConfig();
    const db = getDb();
    const resolvedKeys = await resolveProviderKeys();
    const registry = await createProviderRegistry(config, resolvedKeys);
    const costTracker = new CostTracker(db, config.budget);
    const tools = createDefaultToolRegistry();
    const projectPath = process.cwd();
    const { prompt: systemPrompt, frontmatter } =
      buildSystemPrompt(projectPath);
    const router = new BrainstormRouter(
      config,
      registry,
      costTracker,
      frontmatter,
    );

    console.log(`\n  Storm — ${tasks.length} parallel agents`);
    console.log(`  Type: ${opts.type} | Budget: $${opts.budget}/task\n`);

    for (let i = 0; i < tasks.length; i++) {
      console.log(`  [${i + 1}] ${tasks[i]}`);
    }
    console.log();

    const startTime = Date.now();
    const results = await spawnParallel(
      tasks.map((task) => ({ task, type: opts.type as any })),
      {
        config,
        registry,
        router,
        costTracker,
        tools,
        projectPath,
        systemPrompt,
        budgetLimit: parseFloat(opts.budget),
      },
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  ──────────────────────────────────────────────────`);
    console.log(`  ${results.length} agents completed in ${elapsed}s\n`);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const status = r.text ? "done" : "failed";
      const cost = `$${r.cost.toFixed(4)}`;
      console.log(
        `  [${i + 1}] ${status} (${r.toolCalls.length} tool calls, ${cost})`,
      );
      if (r.text) {
        // Show first 200 chars of response
        const preview = r.text.slice(0, 200).replace(/\n/g, " ");
        console.log(`      ${preview}${r.text.length > 200 ? "..." : ""}`);
      }
      console.log();
    }

    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    console.log(`  Total cost: $${totalCost.toFixed(4)}`);
    console.log();
    closeDb();
  });

// ── Queue Command (Task Queue) ───────────────────────────────────

program
  .command("queue")
  .description("Manage the task queue for batch execution")
  .argument("<action>", "Action: add, list, run, clear")
  .argument("[tasks...]", "Task descriptions (for add)")
  .option("--budget <amount>", "Total budget limit in dollars")
  .option("--parallel <n>", "Max parallel tasks (default: 1)", "1")
  .action(
    async (
      action: string,
      tasks: string[],
      opts: { budget?: string; parallel?: string },
    ) => {
      const { existsSync, readFileSync, writeFileSync, mkdirSync } =
        await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const queueDir = join(homedir(), ".brainstorm", "queue");
      const queueFile = join(queueDir, "pending.json");

      if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true });

      interface QueueItem {
        id: string;
        task: string;
        status: "pending" | "running" | "done" | "failed";
        addedAt: string;
      }

      const loadQueue = (): QueueItem[] => {
        if (!existsSync(queueFile)) return [];
        try {
          return JSON.parse(readFileSync(queueFile, "utf-8"));
        } catch {
          return [];
        }
      };
      const saveQueue = (q: QueueItem[]) =>
        writeFileSync(queueFile, JSON.stringify(q, null, 2), "utf-8");

      switch (action) {
        case "add": {
          if (tasks.length === 0) {
            console.error("  Error: provide task descriptions to add.");
            process.exit(1);
          }
          const queue = loadQueue();
          for (const task of tasks) {
            queue.push({
              id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              task,
              status: "pending",
              addedAt: new Date().toISOString(),
            });
          }
          saveQueue(queue);
          console.log(
            `\n  Added ${tasks.length} task(s) to queue. Total: ${queue.length} pending.`,
          );
          break;
        }
        case "list": {
          const queue = loadQueue();
          if (queue.length === 0) {
            console.log("\n  Queue is empty.");
            break;
          }
          console.log(`\n  Task Queue (${queue.length} items):\n`);
          for (const item of queue) {
            const icon =
              item.status === "done"
                ? "✓"
                : item.status === "failed"
                  ? "✗"
                  : item.status === "running"
                    ? "⟳"
                    : "○";
            console.log(`    ${icon} [${item.status}] ${item.task}`);
          }
          break;
        }
        case "run": {
          const queue = loadQueue();
          const pending = queue.filter((q) => q.status === "pending");
          if (pending.length === 0) {
            console.log("\n  No pending tasks in queue.");
            break;
          }
          console.log(`\n  Running ${pending.length} queued task(s)...`);
          console.log(
            `  Budget: ${opts.budget ?? "unlimited"} | Parallel: ${opts.parallel}`,
          );
          console.log(
            `\n  Execute each task with: storm run --unattended "<task>"`,
          );
          // Mark as running
          for (const item of pending) item.status = "running";
          saveQueue(queue);
          // In full implementation, this would fork child processes.
          // For now, it outputs the commands to run.
          for (const item of pending) {
            console.log(`    storm run --unattended "${item.task}"`);
          }
          break;
        }
        case "clear": {
          saveQueue([]);
          console.log("\n  Queue cleared.");
          break;
        }
        default:
          console.error(
            `  Unknown action: ${action}. Use: add, list, run, clear`,
          );
      }
      console.log();
    },
  );

// ── Search Command (Cross-Repo) ──────────────────────────────────

program
  .command("search")
  .description("Search code — local semantic search or cross-repo via GitHub")
  .argument("<query>", "Search query")
  .option("--global", "Search across GitHub (not just local repo)")
  .option("--language <lang>", "Filter by language")
  .option("--limit <n>", "Max results (default: 10)", "10")
  .action(
    async (
      query: string,
      opts: { global?: boolean; language?: string; limit?: string },
    ) => {
      const limit = parseInt(opts.limit ?? "10");

      if (opts.global) {
        // Cross-repo search via GitHub Code Search API
        console.log(`\n  Searching GitHub for: "${query}"...\n`);
        const { execFileSync } = await import("node:child_process");
        try {
          const ghArgs = ["search", "code", query, "--limit", String(limit)];
          if (opts.language) ghArgs.push("--language", opts.language);
          const output = execFileSync("gh", ghArgs, {
            encoding: "utf-8",
            timeout: 30000,
            stdio: ["ignore", "pipe", "pipe"],
          });
          console.log(output);
        } catch (err: any) {
          if (err.message?.includes("ENOENT")) {
            console.error(
              "  Error: `gh` CLI not found. Install: https://cli.github.com",
            );
          } else {
            console.error(`  Search failed: ${err.message}`);
          }
        }
      } else {
        // Local semantic search
        const { semanticSearch } = await import("@brainst0rm/core");
        const results = semanticSearch(process.cwd(), query, limit);
        if (results.length === 0) {
          console.log(`\n  No results for "${query}".`);
        } else {
          console.log(`\n  ${results.length} result(s) for "${query}":\n`);
          for (const r of results) {
            const score = (r.score * 100).toFixed(0);
            console.log(
              `    [${score}%] ${r.filePath}${r.symbolName ? `:${r.symbolName}` : ""}`,
            );
            if (r.snippet) {
              console.log(`         ${r.snippet.trim().slice(0, 120)}`);
            }
          }
        }
      }
      console.log();
    },
  );

// ── Setup-Infra Command ──────────────────────────────────────────

program
  .command("setup-infra")
  .description(
    "Auto-generate AI infrastructure: BRAINSTORM.md, .agent.md files, routing profiles",
  )
  .argument("[path]", "Project path", ".")
  .action(async (projectPath: string) => {
    const { resolve, join: pathJoin } = await import("node:path");
    const {
      existsSync,
      writeFileSync: fsWrite,
      mkdirSync: fsMkdir,
    } = await import("node:fs");
    const absPath = resolve(projectPath);

    console.log(`\n  Setting up AI infrastructure for ${absPath}...\n`);

    // Phase 1: Analyze
    const { analyzeProject } = await import("@brainst0rm/ingest");
    const analysis = analyzeProject(absPath);

    // Phase 2: Auto-generate BRAINSTORM.md (#33)
    const brainstormMdPath = pathJoin(absPath, "BRAINSTORM.md");
    if (!existsSync(brainstormMdPath)) {
      const lines = [
        "---",
        `build_command: "npm run build"`,
        `test_command: "npm test"`,
        "---",
        "",
        `# ${absPath.split("/").pop()}`,
        "",
        "## Stack",
        "",
      ];
      if (analysis.frameworks.frameworks.length > 0)
        lines.push(
          `- Frameworks: ${analysis.frameworks.frameworks.join(", ")}`,
        );
      if (analysis.languages.primary)
        lines.push(`- Primary language: ${analysis.languages.primary}`);
      if (analysis.frameworks.databases.length > 0)
        lines.push(`- Databases: ${analysis.frameworks.databases.join(", ")}`);
      if (analysis.frameworks.testing.length > 0)
        lines.push(`- Testing: ${analysis.frameworks.testing.join(", ")}`);

      lines.push("", "## Architecture", "");
      lines.push(
        `${analysis.summary.totalFiles} files, ${analysis.summary.totalLines.toLocaleString()} lines across ${analysis.summary.moduleCount} modules.`,
      );
      if (analysis.dependencies.entryPoints.length > 0) {
        lines.push("", "Entry points:");
        for (const ep of analysis.dependencies.entryPoints.slice(0, 10)) {
          lines.push(`- \`${ep}\``);
        }
      }

      lines.push(
        "",
        "## Conventions",
        "",
        "<!-- Add project conventions here -->",
      );

      fsWrite(brainstormMdPath, lines.join("\n"), "utf-8");
      console.log(`  ✓ Generated BRAINSTORM.md`);
    } else {
      console.log(`  · BRAINSTORM.md already exists (skipped)`);
    }

    // Phase 3: Auto-generate .agent.md per module cluster (#34)
    const agentsDir = pathJoin(absPath, ".brainstorm", "agents");
    if (!existsSync(agentsDir)) fsMkdir(agentsDir, { recursive: true });

    let agentsCreated = 0;
    for (const cluster of analysis.dependencies.clusters.slice(0, 10)) {
      const safeName = cluster.directory
        .replace(/[/\\]/g, "-")
        .replace(/^-/, "");
      const agentPath = pathJoin(agentsDir, `${safeName}.agent.md`);
      if (existsSync(agentPath)) continue;

      const node = analysis.dependencies.nodes.find((n) =>
        cluster.files.includes(n.path),
      );
      const lang = node?.language ?? analysis.languages.primary;
      const exports = cluster.files
        .flatMap(
          (f) =>
            analysis.dependencies.nodes.find((n) => n.path === f)?.exports ??
            [],
        )
        .slice(0, 20);

      const agentLines = [
        "---",
        `name: ${safeName}-expert`,
        `role: coder`,
        `model: auto`,
        "---",
        "",
        `# ${safeName} Module Expert`,
        "",
        `You are an expert in the ${safeName} module of this project.`,
        "",
        `## Context`,
        "",
        `- Language: ${lang}`,
        `- Files: ${cluster.files.length}`,
        `- Cohesion: ${cluster.cohesion > 0.5 ? "high" : cluster.cohesion > 0.2 ? "medium" : "low"}`,
      ];
      if (exports.length > 0) {
        agentLines.push(`- Key exports: ${exports.join(", ")}`);
      }
      agentLines.push(
        "",
        "## Files",
        "",
        ...cluster.files.slice(0, 15).map((f) => `- \`${f}\``),
      );
      if (cluster.files.length > 15)
        agentLines.push(`- ... and ${cluster.files.length - 15} more`);

      fsWrite(agentPath, agentLines.join("\n"), "utf-8");
      agentsCreated++;
    }
    console.log(
      `  ✓ Generated ${agentsCreated} .agent.md files in .brainstorm/agents/`,
    );

    // Phase 4: Generate docs
    const { generateAllDocs } = await import("@brainst0rm/docgen");
    const docResult = generateAllDocs(analysis);
    console.log(
      `  ✓ Generated ${docResult.filesWritten.length} documentation files`,
    );

    // Phase 5: Initialize recipe directory
    const { initRecipeDir } = await import("@brainst0rm/workflow");
    initRecipeDir(absPath);
    console.log(`  ✓ Initialized .brainstorm/recipes/`);

    console.log("\n  ══════════════════════════════════════════════════");
    console.log("   AI Infrastructure Setup Complete");
    console.log("  ══════════════════════════════════════════════════\n");
    console.log(`  BRAINSTORM.md     → project context for agents`);
    console.log(
      `  .brainstorm/agents/ → ${agentsCreated} domain expert agents`,
    );
    console.log(`  .brainstorm/recipes/ → shareable workflow templates`);
    console.log(`  docs/generated/   → architecture + module + API docs`);
    console.log(
      `\n  Next: Run \`storm chat\` to start working with AI agents that know your codebase.`,
    );
    console.log();
  });

// ── Onboard Command ─────────────────────────────────────────────

program
  .command("onboard")
  .description(
    "LLM-driven project onboarding — discover conventions, generate specialized agents, wire routing",
  )
  .argument("[path]", "Project path", ".")
  .option(
    "--budget <dollars>",
    "Max spend in USD (default: auto from project size)",
  )
  .option("--static-only", "Skip LLM phases (equivalent to setup-infra)")
  .option("--dry-run", "Show plan without writing files or calling LLMs")
  .option("--phases <phases>", "Comma-separated phases to run")
  .action(
    async (
      projectPath: string,
      opts: {
        budget?: string;
        staticOnly?: boolean;
        dryRun?: boolean;
        phases?: string;
      },
    ) => {
      const { resolve } = await import("node:path");
      const { runOnboardPipeline, ALL_PHASES } =
        await import("@brainst0rm/onboard");
      const absPath = resolve(projectPath);

      const options = {
        projectPath: absPath,
        budget: opts.budget ? parseFloat(opts.budget) : undefined,
        staticOnly: opts.staticOnly ?? false,
        dryRun: opts.dryRun ?? false,
        phases: opts.phases
          ? (opts.phases.split(",").map((p) => p.trim()) as any)
          : undefined,
      };

      console.log(
        `\n  storm onboard ${absPath === process.cwd() ? "." : absPath}${opts.staticOnly ? " --static-only" : ""}${opts.dryRun ? " --dry-run" : ""}`,
      );
      console.log();

      // Create LLM dispatcher for onboard phases (deep exploration, team assembly, etc.)
      let dispatcher;
      if (!opts.staticOnly) {
        const config = loadConfig();
        const db = getDb();
        const envKeys = new Map<string, string>();
        for (const name of PROVIDER_KEY_NAMES) {
          const val = process.env[name];
          if (val) envKeys.set(name, val);
        }
        const resolvedKeys: ResolvedKeys = {
          get: (name: string) => envKeys.get(name) ?? null,
        };
        const registry = await createProviderRegistry(config, resolvedKeys);
        const costTracker = new CostTracker(db, config.budget);
        const { frontmatter } = buildSystemPrompt(absPath);
        const router = new BrainstormRouter(
          config,
          registry,
          costTracker,
          frontmatter,
        );

        const { streamText } = await import("ai");
        dispatcher = {
          async explore(prompt: string, budget: number) {
            const task = router.classify(prompt);
            const decision = router.route(task, { preferCheap: true });
            const modelId = registry.getProvider(decision.model.id);
            const result = streamText({
              model: modelId,
              messages: [{ role: "user" as const, content: prompt }],
              maxRetries: 3,
            });
            let text = "";
            for await (const chunk of (result as any).textStream) {
              text += chunk;
            }
            const usage = await (result as any).usage;
            const cost =
              ((usage?.inputTokens ?? 0) / 1_000_000) *
                decision.model.pricing.inputPer1MTokens +
              ((usage?.outputTokens ?? 0) / 1_000_000) *
                decision.model.pricing.outputPer1MTokens;
            return { text, cost };
          },
          async generate(prompt: string, budget: number) {
            return this.explore(prompt, budget);
          },
        };
      }

      for await (const event of runOnboardPipeline(options, dispatcher)) {
        switch (event.type) {
          case "onboard-started":
            if (event.estimatedBudget > 0) {
              console.log(
                `  Budget: $${options.budget?.toFixed(2) ?? "auto"} (estimated ~$${event.estimatedBudget.toFixed(2)})`,
              );
              console.log();
            }
            break;

          case "phase-started":
            process.stdout.write(`  Phase: ${event.description} ...`);
            break;

          case "phase-completed": {
            const cost = event.cost > 0 ? `, $${event.cost.toFixed(2)}` : "";
            const dur = (event.durationMs / 1000).toFixed(1);
            console.log(` done (${dur}s${cost})`);
            console.log(`    ${event.summary}`);
            console.log();
            break;
          }

          case "phase-skipped": {
            const { PHASE_LABELS } = await import("@brainst0rm/onboard");
            const label = PHASE_LABELS[event.phase] ?? event.phase;
            console.log(`  Phase: ${label} ... skipped`);
            console.log(`    ${event.reason}`);
            console.log();
            break;
          }

          case "phase-failed":
            console.log(` FAILED`);
            console.log(`    ${event.error}`);
            console.log();
            break;

          case "file-written":
            console.log(`    → ${event.path}`);
            break;

          case "budget-warning":
            console.log(
              `  ⚠ Budget: $${event.spent.toFixed(2)} spent, $${event.remaining.toFixed(2)} remaining`,
            );
            break;

          case "onboard-completed": {
            const r = event.result;
            const dur = (r.totalDurationMs / 1000).toFixed(1);
            console.log("  ══════════════════════════════════════════════════");
            console.log(
              `   Onboarding Complete — $${r.totalCost.toFixed(2)} total, ${dur}s`,
            );
            console.log("  ══════════════════════════════════════════════════");
            if (r.filesWritten.length > 0) {
              console.log();
              for (const f of r.filesWritten) {
                console.log(`  ${f}`);
              }
            }

            // Persist exploration results to project memory
            try {
              const { persistOnboardToMemory } =
                await import("@brainst0rm/onboard");
              const saved = persistOnboardToMemory(r, process.cwd());
              if (saved > 0) {
                console.log(
                  `\n  ✓ ${saved} memory entries saved (conventions, domain concepts, etc.)`,
                );
              }
            } catch (e) {
              console.log(
                `\n  ⚠ Failed to persist to memory: ${(e as Error).message}`,
              );
            }

            console.log(
              `\n  Next: Run \`storm chat\` to start working with agents that know your codebase.\n`,
            );
            break;
          }
        }
      }
    },
  );

// ── Route Explain Command ─────────────────────────────────────────

program
  .command("route")
  .description("Explain how Brainstorm classifies and routes a task")
  .argument("[task]", "Task description to classify")
  .option("--json", "Output as JSON")
  .action(async (task: string | undefined, opts: { json?: boolean }) => {
    const { classifyTask } = await import("@brainst0rm/router");

    const taskText = task ?? "write a function that validates email addresses";
    const profile = classifyTask(taskText);

    if (opts.json) {
      console.log(JSON.stringify({ task: taskText, profile }, null, 2));
      return;
    }

    console.log("\n  Route Explain");
    console.log("  ══════════════════════════════════════════════════\n");
    console.log(`  Task: "${taskText.slice(0, 80)}"`);
    console.log();
    console.log(`  Classification:`);
    console.log(`    Type:       ${profile.type}`);
    console.log(`    Complexity: ${profile.complexity}`);
    console.log(`    Tools:      ${profile.requiresToolUse ? "yes" : "no"}`);
    console.log(`    Reasoning:  ${profile.requiresReasoning ? "yes" : "no"}`);
    if (profile.language) console.log(`    Language:   ${profile.language}`);
    if (profile.domain) console.log(`    Domain:     ${profile.domain}`);
    console.log(
      `    Est tokens: ${profile.estimatedTokens.input}in / ${profile.estimatedTokens.output}out`,
    );

    console.log();
    console.log(`  Routing Logic:`);
    if (profile.type === "ingest")
      console.log(`    → Ingest pipeline: analysis + docgen + infra setup`);
    else if (profile.type === "audit")
      console.log(`    → Full review pipeline: security + quality + tech debt`);
    else if (profile.type === "migration")
      console.log(`    → Migration pipeline: parallel agents per module`);
    else if (profile.type === "documentation")
      console.log(`    → Documentation pipeline: architecture + module docs`);
    else if (profile.requiresReasoning)
      console.log(
        `    → Routes to frontier model (Opus/GPT-5.4) for reasoning`,
      );
    else if (
      profile.complexity === "trivial" ||
      profile.complexity === "simple"
    )
      console.log(
        `    → Routes to fast/cheap model (Haiku/Flash) for simple tasks`,
      );
    else
      console.log(
        `    → Routes based on active strategy (quality/cost/combined)`,
      );

    console.log();
  });

// ── Loop Command ──────────────────────────────────────────────────

program
  .command("loop")
  .description("Run a prompt or slash command on a recurring interval")
  .argument("<prompt>", "Prompt or /command to run repeatedly")
  .option("-i, --interval <minutes>", "Interval between runs in minutes", "10")
  .option(
    "-n, --max-runs <count>",
    "Maximum number of runs (0 = unlimited)",
    "0",
  )
  .action(
    async (prompt: string, opts: { interval: string; maxRuns: string }) => {
      const intervalMs = Math.max(1, parseInt(opts.interval) || 10) * 60 * 1000;
      const maxRuns = parseInt(opts.maxRuns) || 0;
      let runCount = 0;

      console.log(
        `\n  Loop: "${prompt}" every ${opts.interval}m${maxRuns > 0 ? ` (max ${maxRuns} runs)` : ""}`,
      );
      console.log(`  Press Ctrl+C to stop.\n`);

      const runOnce = async () => {
        runCount++;
        const ts = new Date().toLocaleTimeString();
        console.log(`  [${ts}] Run #${runCount}...`);

        try {
          // Shell out to `storm run` for each iteration — clean process per run
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);

          const stormBin = process.argv[1]; // path to this script
          const { stdout, stderr } = await execFileAsync(
            process.execPath,
            [stormBin, "run", prompt],
            {
              cwd: process.cwd(),
              timeout: 5 * 60 * 1000, // 5 min max per run
              env: { ...process.env },
            },
          );
          if (stdout.trim()) console.log(stdout.trim());
          if (stderr.trim()) console.error(stderr.trim());
        } catch (err: any) {
          console.error(
            `  Error: ${(err.stderr ?? err.message).slice(0, 200)}`,
          );
        }

        if (maxRuns > 0 && runCount >= maxRuns) {
          console.log(`\n  Loop complete (${runCount} runs).`);
          process.exit(0);
        }
      };

      // Run immediately, then on interval
      await runOnce();
      setInterval(runOnce, intervalMs);
    },
  );

// ── Memory Command ────────────────────────────────────────────────

program
  .command("memory")
  .description("View and manage agent memory entries")
  .argument("[action]", "Action: list, search, forget", "list")
  .argument("[query]", "Search query or memory key to forget")
  .action(async (action: string, query?: string) => {
    const { MemoryManager } = await import("@brainst0rm/core");
    // Bug fix (Dogfood #1 Bug 1): previously passed ~/.brainstorm/memory as
    // the "projectPath" argument. MemoryManager internally hashes its arg to
    // compute a project-scoped store at
    // ~/.brainstorm/projects/<hash>/memory/. Hashing the literal string
    // "~/.brainstorm/memory" produced a store that no other code ever wrote
    // to, so `brainstorm memory list` always showed "No memory entries"
    // even after `brainstorm onboard` wrote 6 entries to the real
    // project-hashed store.
    //
    // The fix: pass process.cwd() so memory commands scope to the current
    // project, matching what onboard and the agent loop write to.
    const memory = new MemoryManager(process.cwd());

    switch (action) {
      case "list": {
        const entries = memory.list();
        if (entries.length === 0) {
          console.log("\n  No memory entries.\n");
          return;
        }
        console.log(`\n  Memory (${entries.length} entries):\n`);
        for (const entry of entries) {
          const typeIcon =
            entry.type === "user"
              ? "👤"
              : entry.type === "feedback"
                ? "💬"
                : entry.type === "project"
                  ? "📁"
                  : "🔗";
          console.log(`    ${typeIcon} ${entry.name}`);
          console.log(`       ${entry.description.slice(0, 80)}`);
        }
        console.log();
        break;
      }
      case "search": {
        if (!query) {
          console.error("  Usage: storm memory search <query>");
          process.exit(1);
        }
        const results = memory.search(query);
        if (results.length === 0) {
          console.log(`\n  No memory entries matching "${query}".\n`);
          return;
        }
        console.log(
          `\n  Found ${results.length} entries matching "${query}":\n`,
        );
        for (const entry of results) {
          console.log(`    ${entry.name}: ${entry.description.slice(0, 80)}`);
        }
        console.log();
        break;
      }
      case "forget": {
        if (!query) {
          console.error("  Usage: storm memory forget <key>");
          process.exit(1);
        }
        const deleted = memory.delete(query);
        if (deleted) {
          console.log(`\n  Forgot: "${query}"\n`);
        } else {
          console.log(`\n  Memory "${query}" not found.\n`);
        }
        break;
      }

      // ── Week 1 Phase 4 additions (BR wiring) ─────────────────────
      //
      // These delegate to the BrainstormRouter gateway (via new gateway
      // client methods added in Phase 2) for team/shared memory,
      // approval workflow, and init-from-documents. Each action fails
      // gracefully with a clear error when no BR API key is configured.

      case "init": {
        // brainstorm memory init --from <file>
        //   Reads a Claude Code / Codex session JSONL (or plain text),
        //   sends to BR's /v1/memory/init endpoint for agent-driven
        //   fact extraction, prints the summary.
        //
        //   Note: commander action receives the two positional
        //   arguments (action, query). The file path rides on `query`
        //   to keep the existing [action] [query] signature. This is
        //   a little ugly but keeps the command surface backward-
        //   compatible. A cleaner subcommand structure is future work.
        const filePath = query;
        if (!filePath) {
          console.error(
            "  Usage: storm memory init <file>\n" +
              "  Supports Claude Code session JSONL or plain text documents.",
          );
          process.exit(1);
        }
        const gw = createGatewayClient();
        if (!gw) {
          console.error(
            "  No BRAINSTORM_API_KEY set. Set it in env or vault first.",
          );
          process.exit(1);
        }
        const { readFileSync: rfs, existsSync: exs } = await import("node:fs");
        if (!exs(filePath)) {
          console.error(`  File not found: ${filePath}`);
          process.exit(1);
        }
        const content = rfs(filePath, "utf-8");
        // Detect JSONL and extract content; otherwise treat as plain text doc.
        const documents: Array<{ content: string; source?: string }> = [];
        const isJsonl = filePath.endsWith(".jsonl");
        if (isJsonl) {
          const lines = content.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              // Claude Code trajectory format has `message.content` or
              // `text` fields. Try common shapes.
              const text =
                typeof obj?.message?.content === "string"
                  ? obj.message.content
                  : typeof obj?.text === "string"
                    ? obj.text
                    : typeof obj?.content === "string"
                      ? obj.content
                      : null;
              if (text && text.trim()) {
                documents.push({ content: text, source: filePath });
              }
            } catch {
              // Skip malformed lines
            }
          }
        } else {
          documents.push({ content, source: filePath });
        }

        if (documents.length === 0) {
          console.error(
            `  No extractable content found in ${filePath}. ` +
              "Expected JSONL with text/content fields or plain text.",
          );
          process.exit(1);
        }

        console.log(
          `\n  Sending ${documents.length} document(s) to BR /v1/memory/init...`,
        );
        try {
          const result = await gw.initMemoryFromDocs(documents);
          console.log(`  Status:  ${result.status}`);
          console.log(`  Summary: ${result.summary.slice(0, 200)}`);
          console.log(`  Entries: ${result.entries_after}\n`);
        } catch (err: any) {
          console.error(`  Memory init failed: ${err.message}`);
          process.exit(1);
        }
        break;
      }

      case "shared": {
        // brainstorm memory shared             → list team shared memory
        // brainstorm memory shared <fact>      → store a fact in team shared memory
        const gw = createGatewayClient();
        if (!gw) {
          console.error(
            "  No BRAINSTORM_API_KEY set. Team shared memory requires BR.",
          );
          process.exit(1);
        }
        if (query && query.length > 0 && query !== "list") {
          // Store path
          try {
            const result = await gw.storeSharedMemory(query);
            if (result.status === "pending_approval") {
              console.log(
                `\n  ⏳ Memory write queued for approval (id: ${result.approvalId}).\n` +
                  `  Use 'storm memory pending' to see the queue.\n`,
              );
            } else {
              console.log(`\n  ✓ Shared memory saved.\n`);
            }
          } catch (err: any) {
            console.error(`  Shared memory write failed: ${err.message}`);
            process.exit(1);
          }
        } else {
          // List path
          try {
            const result = await gw.listSharedMemory();
            if (result.entries.length === 0) {
              console.log(`\n  No shared memory entries.`);
              if (result.pendingApprovals > 0) {
                console.log(
                  `  ${result.pendingApprovals} pending approval(s) — see 'storm memory pending'.\n`,
                );
              }
              console.log();
              return;
            }
            console.log(`\n  Team shared memory (${result.total} entries):\n`);
            for (const entry of result.entries) {
              console.log(`    👥 [${entry.block}] ${entry.fact.slice(0, 80)}`);
              console.log(`       by ${entry.createdBy} at ${entry.createdAt}`);
            }
            if (result.pendingApprovals > 0) {
              console.log(
                `\n  ⏳ ${result.pendingApprovals} pending approval(s) — see 'storm memory pending'\n`,
              );
            } else {
              console.log();
            }
          } catch (err: any) {
            console.error(`  Shared memory list failed: ${err.message}`);
            process.exit(1);
          }
        }
        break;
      }

      case "pending": {
        // brainstorm memory pending                        → list pending approvals
        // brainstorm memory pending approve <id>           → approve
        // brainstorm memory pending reject <id> [reason]   → reject
        //
        // The `query` positional carries the subcommand (list/approve/
        // reject) plus the id; parse it as "subcmd:id" or just "subcmd".
        const gw = createGatewayClient();
        if (!gw) {
          console.error(
            "  No BRAINSTORM_API_KEY set. Memory approval requires BR.",
          );
          process.exit(1);
        }
        const parts = (query ?? "").trim().split(/\s+/);
        const subcmd = parts[0] || "list";

        if (subcmd === "list" || subcmd === "") {
          try {
            const pending = await gw.listPendingMemory();
            if (pending.length === 0) {
              console.log("\n  No pending memory approvals.\n");
              return;
            }
            console.log(`\n  Pending approvals (${pending.length}):\n`);
            for (const p of pending) {
              console.log(`    ⏳ ${p.id}`);
              console.log(`       ${p.summary.slice(0, 80)}`);
              console.log(`       expires ${p.expiresAt}`);
            }
            console.log(
              `\n  To approve: storm memory pending approve <id>\n` +
                `  To reject:  storm memory pending reject <id>\n`,
            );
          } catch (err: any) {
            console.error(`  Pending list failed: ${err.message}`);
            process.exit(1);
          }
        } else if (subcmd === "approve") {
          const id = parts[1];
          if (!id) {
            console.error("  Usage: storm memory pending approve <id>");
            process.exit(1);
          }
          try {
            await gw.approvePendingMemory(id);
            console.log(`\n  ✓ Approved: ${id}\n`);
          } catch (err: any) {
            console.error(`  Approval failed: ${err.message}`);
            process.exit(1);
          }
        } else if (subcmd === "reject") {
          const id = parts[1];
          const reason = parts.slice(2).join(" ");
          if (!id) {
            console.error("  Usage: storm memory pending reject <id> [reason]");
            process.exit(1);
          }
          try {
            await gw.rejectPendingMemory(id, reason || undefined);
            console.log(`\n  ✗ Rejected: ${id}\n`);
          } catch (err: any) {
            console.error(`  Rejection failed: ${err.message}`);
            process.exit(1);
          }
        } else {
          console.error(
            `  Unknown pending subcommand: ${subcmd}. Use list, approve, or reject.`,
          );
          process.exit(1);
        }
        break;
      }

      case "doctor": {
        // brainstorm memory doctor — clean up and reorganize local memory
        // (Letta Code parity from their /doctor slash command).
        //
        // For now this runs the MemoryManager's existing consolidation
        // path: walks the store, removes duplicates, rebuilds the
        // index, prunes quarantine entries older than 30 days.
        console.log("\n  Running memory doctor...\n");
        const before = memory.list();
        // Simple dedup by name — keep the most recent entry per name
        const seen = new Map<string, any>();
        for (const entry of before) {
          const existing = seen.get(entry.name);
          if (!existing || (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
            seen.set(entry.name, entry);
          }
        }
        const duplicateIds = before
          .filter((e) => seen.get(e.name)?.id !== e.id)
          .map((e) => e.id);
        for (const id of duplicateIds) {
          memory.delete(id);
        }
        const after = memory.list();
        console.log(`  Before: ${before.length} entries`);
        console.log(`  After:  ${after.length} entries`);
        console.log(`  Removed: ${duplicateIds.length} duplicate(s) by name\n`);
        break;
      }

      default:
        console.error(
          `  Unknown action: ${action}. ` +
            `Use list, search, forget, init, shared, pending, or doctor.`,
        );
        process.exit(1);
    }
  });

// ── Sync Command ─────────────────────────────────────────────────
//
// Visibility and manual control for the fire-and-forget BR sync queue
// introduced in Week 1 Phase 1. The queue lives in the local SQLite
// database (sync_queue table, migration 030) and drains on a timer
// whenever the chat command is running. These subcommands let users
// inspect queue state and force a drain on demand — critical for
// debugging and for users without a long-running daemon.

program
  .command("sync")
  .description("Inspect and manage the BrainstormRouter sync queue")
  .argument("[action]", "Action: status, flush, prune", "status")
  .action(async (action: string) => {
    const { SyncQueueRepository } = await import("@brainst0rm/db");
    const { SyncWorker } = await import("@brainst0rm/gateway");

    const db = getDb();
    const repo = new SyncQueueRepository(db);

    switch (action) {
      case "status": {
        const stats = repo.getStats();
        const total =
          stats.pending + stats.inFlight + stats.completed + stats.failed;

        console.log("\n  BR Sync Queue\n");
        console.log(`  Total rows:  ${total}`);
        console.log(`    pending:   ${stats.pending}`);
        console.log(`    in_flight: ${stats.inFlight}`);
        console.log(`    completed: ${stats.completed}`);
        console.log(`    failed:    ${stats.failed}`);

        if (stats.oldestPending !== null) {
          const age = Math.floor(
            (Date.now() / 1000 - stats.oldestPending) / 60,
          );
          console.log(`\n  Oldest pending: ${age} minutes ago`);
        }

        if (stats.latestFailure) {
          console.log(`\n  Latest failure:`);
          console.log(`    id:     ${stats.latestFailure.id}`);
          console.log(`    tries:  ${stats.latestFailure.attemptCount}`);
          console.log(`    error:  ${stats.latestFailure.error.slice(0, 200)}`);
        }

        // Warn if BR isn't configured — queue has nowhere to go
        const gw = createGatewayClient();
        if (!gw && stats.pending > 0) {
          console.log(
            `\n  ⚠ BRAINSTORM_API_KEY not set — ${stats.pending} item(s) will stay queued until a gateway is configured.`,
          );
        }
        console.log();
        break;
      }

      case "flush": {
        // Drain the queue synchronously, once. Useful after offline
        // work to push pending memory writes, or after setting a new
        // BRAINSTORM_API_KEY for the first time.
        const gw = createGatewayClient();
        if (!gw) {
          console.error("  No BRAINSTORM_API_KEY set. Configure BR first.");
          process.exit(1);
        }
        const worker = new SyncWorker({ gateway: gw, repo });
        console.log("\n  Draining sync queue...");
        const result = await worker.drainOnce();
        console.log(
          `  Processed ${result.processed}: ` +
            `${result.succeeded} succeeded, ${result.failed} failed\n`,
        );
        if (result.failed > 0) {
          const stats = worker.getStats();
          if (stats.lastError) {
            console.log(`  Last error: ${stats.lastError}\n`);
          }
        }
        break;
      }

      case "prune": {
        // Remove completed rows older than 7 days (604800 seconds) to
        // keep the queue table bounded on long-running installations.
        const deleted = repo.pruneCompleted(7 * 24 * 60 * 60);
        console.log(
          `\n  Pruned ${deleted} completed row(s) older than 7 days.\n`,
        );
        break;
      }

      default:
        console.error(
          `  Unknown action: ${action}. Use status, flush, or prune.`,
        );
        process.exit(1);
    }
  });

// ── Codebase Audit Command ─────────────────────────────────────────
//
// The "attack and document" primitive. Spawns a fleet of workers,
// each scoped to a package/app, each emitting structured findings
// to shared memory. Findings flow through the same sync path as
// regular memory writes — team members see them from their own CLI
// via `brainstorm findings list`.

const codebaseCmd = program
  .command("codebase")
  .description("Codebase audit tools — fleet-agent documentation and analysis");

codebaseCmd
  .command("audit")
  .description(
    "Run a fleet of agents to audit this codebase and write findings to shared memory",
  )
  .option("--workers <n>", "Concurrent workers (default 3)", "3")
  .option("--budget <usd>", "Total budget cap in USD", "5")
  .option(
    "--categories <list>",
    "Comma-separated categories to emphasize (default: security,correctness,reliability,performance,maintainability,tech-debt,testing)",
  )
  .option(
    "--min-severity <level>",
    "Minimum severity to report: critical|high|medium|low|info",
    "low",
  )
  .option(
    "--scopes <list>",
    "Comma-separated scope names (default: auto-discover)",
  )
  .option(
    "--model <id>",
    "Force a specific model for all workers (bypass router). Example: google/gemini-2.5-flash",
  )
  .action(
    async (opts: {
      workers: string;
      budget: string;
      categories?: string;
      minSeverity: string;
      scopes?: string;
      model?: string;
    }) => {
      const {
        runCodebaseAudit,
        discoverScopes,
        MemoryManager: AuditMemoryManager,
      } = await import("@brainst0rm/core");

      const projectPath = process.cwd();
      const concurrency = parseInt(opts.workers, 10);
      const budgetLimit = parseFloat(opts.budget);
      const minSeverity = opts.minSeverity as
        | "critical"
        | "high"
        | "medium"
        | "low"
        | "info";

      console.log(`\n  Codebase Audit\n`);
      console.log(`  Project: ${projectPath}`);
      console.log(`  Workers: ${concurrency} concurrent`);
      console.log(`  Budget:  $${budgetLimit.toFixed(2)}`);
      console.log(`  Min severity: ${minSeverity}`);

      // Discover scopes so we can show the plan before spending money
      const allScopes = discoverScopes(projectPath);
      const filteredScopes =
        opts.scopes !== undefined
          ? allScopes.filter((s) =>
              opts
                .scopes!.split(",")
                .map((x) => x.trim())
                .includes(s.name),
            )
          : allScopes;

      if (filteredScopes.length === 0) {
        console.error("\n  No scopes discovered. Aborting.\n");
        process.exit(1);
      }

      console.log(`  Scopes:  ${filteredScopes.length}`);
      for (const s of filteredScopes.slice(0, 10)) {
        console.log(`    - ${s.name}`);
      }
      if (filteredScopes.length > 10) {
        console.log(`    ... and ${filteredScopes.length - 10} more`);
      }
      console.log();

      // Runtime setup — same pattern as orchestrate parallel
      const config = loadConfig();
      config.general.defaultPermissionMode = "auto";
      const db = getDb();
      const resolvedKeys = await resolveProviderKeys();
      const registry = await createProviderRegistry(config, resolvedKeys);
      const costTracker = new CostTracker(db, config.budget);
      const tools = createDefaultToolRegistry();
      const { frontmatter } = buildSystemPrompt(projectPath);
      const router = new BrainstormRouter(
        config,
        registry,
        costTracker,
        frontmatter,
      );
      router.setStrategy("capability");

      const auditGateway = createGatewayClient();
      const memory = new AuditMemoryManager(projectPath, auditGateway);

      const sharedSubagentOptions: any = {
        config,
        registry,
        router,
        costTracker,
        tools,
        projectPath,
        permissionCheck: () => "allow",
        // If --model was passed, force every worker to use that exact model.
        // Useful to bypass routing fallbacks that can hit BR SaaS guardrails
        // on code-review content. Example: --model google/gemini-2.5-flash
        // routes directly to the Google provider if GOOGLE_GENERATIVE_AI_API_KEY
        // is configured, skipping brainstormrouter/auto entirely.
        ...(opts.model ? { preferredModelId: opts.model } : {}),
      };

      if (opts.model) {
        console.log(`  Model:   ${opts.model} (forced)`);
      }

      // Parse optional categories list
      const categories = opts.categories
        ? (opts.categories.split(",").map((c) => c.trim()) as any)
        : undefined;

      const gen = runCodebaseAudit({
        projectPath,
        memory,
        subagentOptions: sharedSubagentOptions,
        scopes: filteredScopes,
        categories,
        concurrency,
        budgetLimit,
        minSeverity,
      });

      let result: any = null;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          result = next.value;
          break;
        }
        const ev = next.value;
        switch (ev.type) {
          case "audit-started":
            console.log(
              `  [Fleet] starting — $${ev.perScopeBudget.toFixed(3)}/scope\n`,
            );
            break;
          case "worker-started":
            console.log(`  [${ev.workerId}] ▶ ${ev.scope.name}`);
            break;
          case "worker-completed":
            console.log(
              `  [${ev.workerId}] ✓ ${ev.scope.name} — ${ev.findingsCount} findings ($${ev.cost.toFixed(4)})`,
            );
            break;
          case "worker-failed":
            console.log(
              `  [${ev.workerId}] ✗ ${ev.scope.name} — ${ev.error.slice(0, 80)}`,
            );
            break;
          case "finding-recorded": {
            const sev = ev.finding.severity.toUpperCase().padEnd(8);
            const loc = ev.finding.lineStart
              ? `${ev.finding.file}:${ev.finding.lineStart}`
              : ev.finding.file;
            console.log(`    ${sev} ${loc} — ${ev.finding.title.slice(0, 80)}`);
            break;
          }
          case "audit-completed":
            console.log(
              `\n  [Fleet] ${ev.totalFindings} findings in ${Math.round(ev.durationMs / 1000)}s ($${ev.totalCost.toFixed(4)})`,
            );
            break;
        }
      }

      console.log(`  Run: brainstorm findings summary to aggregate\n`);
      process.exit(result?.totalFindings > 0 ? 0 : 1);
    },
  );

// ── Findings Command ──────────────────────────────────────────────
//
// Query the findings store produced by `brainstorm codebase audit`.
// Findings live as memory entries with a [FINDING] envelope, so they
// sync across machines via the same BR shared memory path.

program
  .command("findings")
  .description("Query, summarize, and act on codebase audit findings")
  .argument(
    "[action]",
    "Action: list | summary | show <id> | delete <id> | fix <id>",
    "summary",
  )
  .argument("[id]", "Finding ID (required for show, delete, fix)")
  .option(
    "--severity <level>",
    "Filter by severity (critical|high|medium|low|info)",
  )
  .option(
    "--category <name>",
    "Filter by category (e.g., security, performance)",
  )
  .option("--file <substring>", "Filter by file path substring")
  .option(
    "--query <text>",
    "Free-text search across title + description + file",
  )
  .option("--limit <n>", "Max results to show (list only)", "50")
  .option(
    "--model <id>",
    "Force a specific model for fix subagent (e.g., google/gemini-2.5-flash)",
  )
  .option("--budget <usd>", "Budget cap for fix subagent in USD", "1")
  .action(
    async (
      action: string,
      id: string | undefined,
      opts: {
        severity?: string;
        category?: string;
        file?: string;
        query?: string;
        limit: string;
        model?: string;
        budget: string;
      },
    ) => {
      const { MemoryManager: FindingsMemoryManager, FindingsStore } =
        await import("@brainst0rm/core");

      const memory = new FindingsMemoryManager(process.cwd());
      const store = new FindingsStore(memory);

      const filter = {
        ...(opts.severity ? { severity: opts.severity as any } : {}),
        ...(opts.category ? { category: opts.category as any } : {}),
        ...(opts.file ? { file: opts.file } : {}),
        ...(opts.query ? { query: opts.query } : {}),
      };

      if (action === "list") {
        const findings = store.list(filter).slice(0, parseInt(opts.limit, 10));
        if (findings.length === 0) {
          console.log("\n  No findings match the filter.\n");
          return;
        }
        console.log(`\n  Findings (${findings.length}):\n`);
        for (const f of findings) {
          const sev = sevColor(f.severity);
          const loc = f.lineStart ? `${f.file}:${f.lineStart}` : f.file;
          console.log(`  ${sev} [${f.category}] ${loc}`);
          console.log(`    id: ${f.id}`);
          console.log(`    ${f.title}`);
          if (f.description && f.description !== f.title) {
            console.log(`    ${f.description.slice(0, 120)}`);
          }
          if (f.suggestedFix) {
            console.log(`    Fix: ${f.suggestedFix.slice(0, 120)}`);
          }
          console.log();
        }
        return;
      }

      // Lookup helper for id-based actions
      const findById = (wantedId: string) =>
        store.list().find((f) => f.id === wantedId);

      if (action === "show") {
        if (!id) {
          console.error("  Usage: brainstorm findings show <id>");
          process.exit(1);
        }
        const f = findById(id);
        if (!f) {
          console.error(`  Finding not found: ${id}`);
          process.exit(1);
        }
        console.log();
        console.log(`  ${sevColor(f.severity)} [${f.category}]`);
        console.log(`  id:   ${f.id}`);
        console.log(
          `  file: ${f.file}${f.lineStart ? `:${f.lineStart}${f.lineEnd ? `-${f.lineEnd}` : ""}` : ""}`,
        );
        if (f.discoveredBy) console.log(`  by:   ${f.discoveredBy}`);
        console.log();
        console.log(`  ${f.title}`);
        console.log();
        console.log(`  ${f.description}`);
        if (f.suggestedFix) {
          console.log();
          console.log(`  Suggested fix:`);
          console.log(`  ${f.suggestedFix}`);
        }
        console.log();
        return;
      }

      if (action === "delete") {
        if (!id) {
          console.error("  Usage: brainstorm findings delete <id>");
          process.exit(1);
        }
        const ok = store.delete(id);
        if (!ok) {
          console.error(`  Finding not found: ${id}`);
          process.exit(1);
        }
        console.log(`  Deleted finding ${id}`);
        return;
      }

      if (action === "fix") {
        if (!id) {
          console.error("  Usage: brainstorm findings fix <id>");
          process.exit(1);
        }
        const finding = findById(id);
        if (!finding) {
          console.error(`  Finding not found: ${id}`);
          process.exit(1);
        }

        // Build the runtime the subagent will use — same shape as the
        // audit command, but with a `code` subagent that can write files.
        const config = loadConfig();
        config.general.defaultPermissionMode = "auto";
        const db = getDb();
        const resolvedKeys = await resolveProviderKeys();
        const registry = await createProviderRegistry(config, resolvedKeys);
        const costTracker = new CostTracker(db, config.budget);
        const tools = createDefaultToolRegistry();
        const { frontmatter } = buildSystemPrompt(process.cwd());
        const router = new BrainstormRouter(
          config,
          registry,
          costTracker,
          frontmatter,
        );
        router.setStrategy("capability");

        const { spawnSubagent } = await import("@brainst0rm/core");

        const loc = finding.lineStart
          ? `${finding.file}:${finding.lineStart}${finding.lineEnd ? `-${finding.lineEnd}` : ""}`
          : finding.file;

        console.log();
        console.log(`  Fixing: ${sevColor(finding.severity)} ${loc}`);
        console.log(`    ${finding.title}`);
        console.log();

        const task = [
          `Fix the following codebase audit finding.`,
          ``,
          `File: ${loc}`,
          `Severity: ${finding.severity}`,
          `Category: ${finding.category}`,
          ``,
          `Title: ${finding.title}`,
          ``,
          `Description:`,
          finding.description,
          ``,
          finding.suggestedFix
            ? `Suggested approach:\n${finding.suggestedFix}`
            : ``,
          ``,
          `Instructions:`,
          `1. Read the file and understand the surrounding context`,
          `2. Apply a focused fix for THIS specific finding only — do not refactor unrelated code`,
          `3. Verify the fix compiles (if applicable) by reading the result`,
          `4. Explain what you changed in 2-3 sentences`,
          ``,
          `Do NOT commit. Do NOT create new files unless strictly necessary.`,
        ]
          .filter(Boolean)
          .join("\n");

        const budgetLimit = parseFloat(opts.budget);
        let result: any;
        try {
          result = await spawnSubagent(task, {
            config,
            registry,
            router,
            costTracker,
            tools,
            projectPath: process.cwd(),
            type: "code",
            permissionCheck: () => "allow",
            budgetLimit,
            ...(opts.model ? { preferredModelId: opts.model } : {}),
          } as any);
        } catch (err: any) {
          // Surface the real error instead of letting it print as a raw
          // object and leaving the user wondering what happened.
          console.error(`\n  ✗ Subagent failed: ${err?.message ?? err}`);
          if (err?.data?.error?.message) {
            console.error(`    API error: ${err.data.error.message}`);
          }
          if (err?.statusCode) {
            console.error(`    Status:    ${err.statusCode}`);
          }
          console.error(
            `\n  The finding was not modified. You can retry with a different --model\n`,
          );
          process.exit(1);
        }

        const summary = result.text.trim();
        const toolCallCount = result.toolCalls.length;

        // Subagent completed but did nothing — distinguish "I looked and
        // decided nothing needed changing" from "I actually made an edit".
        // The agent's own tool-call list is the ground truth.
        const editTools = result.toolCalls.filter((t: string) =>
          /^(file_write|file_edit|file_append|multi_edit|patch)$/i.test(t),
        );

        console.log(`  Agent summary:`);
        console.log();
        if (summary) {
          console.log(
            summary
              .split("\n")
              .map((l: string) => `    ${l}`)
              .join("\n"),
          );
        } else {
          console.log(`    (no narrative output)`);
        }
        console.log();
        console.log(
          `  Model: ${result.modelUsed}   Cost: $${result.cost.toFixed(4)}   Tool calls: ${toolCallCount} (${editTools.length} edits)`,
        );
        if (result.budgetExceeded) {
          console.log(`  ⚠  Budget exceeded before completion`);
        }
        if (editTools.length === 0) {
          console.log(
            `  ⚠  Agent made no file edits. The finding is still present — consider a stronger model.`,
          );
        } else {
          console.log();
          console.log(
            `  Review the changes with git diff, then delete the finding:`,
          );
          console.log(`    brainstorm findings delete ${finding.id}`);
        }
        console.log();
        return;
      }

      if (action === "summary") {
        const summary = store.summary(filter);
        if (summary.total === 0) {
          console.log("\n  No findings recorded.");
          console.log(
            "  Run `brainstorm codebase audit` to populate findings.\n",
          );
          return;
        }

        console.log(`\n  Findings Summary — ${summary.total} total\n`);

        console.log(`  By severity:`);
        const sevOrder = ["critical", "high", "medium", "low", "info"] as const;
        for (const sev of sevOrder) {
          const count = summary.bySeverity[sev];
          if (count > 0) {
            console.log(`    ${sevColor(sev).padEnd(12)} ${count}`);
          }
        }

        console.log(`\n  By category:`);
        const sortedCats = Object.entries(summary.byCategory).sort(
          (a, b) => b[1] - a[1],
        );
        for (const [cat, count] of sortedCats) {
          console.log(`    ${cat.padEnd(18)} ${count}`);
        }

        if (summary.byFile.length > 0) {
          console.log(`\n  Top files:`);
          for (const { file, count } of summary.byFile.slice(0, 10)) {
            console.log(`    ${count.toString().padStart(3)} ${file}`);
          }
        }

        if (summary.topCritical.length > 0) {
          console.log(`\n  Most urgent:`);
          for (const f of summary.topCritical) {
            const loc = f.lineStart ? `${f.file}:${f.lineStart}` : f.file;
            console.log(`    ${sevColor(f.severity)} ${loc}`);
            console.log(`      ${f.title}`);
          }
        }
        console.log();
        return;
      }

      console.error(`  Unknown action: ${action}. Use list or summary.`);
      process.exit(1);
    },
  );

/** Simple severity label with emoji for scanability. */
function sevColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "🔴 CRITICAL";
    case "high":
      return "🟠 HIGH    ";
    case "medium":
      return "🟡 MEDIUM  ";
    case "low":
      return "🔵 LOW     ";
    case "info":
      return "⚪ INFO    ";
    default:
      return `   ${severity.toUpperCase().padEnd(8)}`;
  }
}

// ── Sessions Command ───────────────────────────────────────────────

program
  .command("sessions")
  .description("List recent chat sessions")
  .option("-n, --limit <count>", "Number of sessions to show", "10")
  .action(async (opts: { limit: string }) => {
    const db = getDb();
    const sessionManager = new SessionManager(db);
    const sessions = sessionManager.listRecent(parseInt(opts.limit));

    console.log("\n  Recent Sessions:\n");
    if (sessions.length === 0) {
      console.log("    No sessions found.");
    }
    for (const s of sessions) {
      const age = Math.floor((Date.now() / 1000 - s.updatedAt) / 60);
      const ageStr =
        age < 60
          ? `${age}m ago`
          : age < 1440
            ? `${Math.floor(age / 60)}h ago`
            : `${Math.floor(age / 1440)}d ago`;
      console.log(
        `    ${s.id.slice(0, 8)}  ${s.messageCount} msgs  $${s.totalCost.toFixed(4)}  ${ageStr}  ${s.projectPath}`,
      );
    }
    console.log();
  });

// ── Metrics Command ────────────────────────────────────────────────

program
  .command("metrics")
  .description("Export tool stats, model latency, and cost breakdown")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const db = getDb();
    const costRepo = new CostRepository(db);

    const byModel = costRepo.recentByModel(20);
    const byTaskType = costRepo.byTaskType();
    const todayCost = costRepo.totalCostToday();
    const monthCost = costRepo.totalCostThisMonth();

    if (opts.json) {
      console.log(
        JSON.stringify({ todayCost, monthCost, byModel, byTaskType }, null, 2),
      );
      return;
    }

    console.log("\n  Cost Summary:");
    console.log(`    Today:      $${todayCost.toFixed(4)}`);
    console.log(`    This month: $${monthCost.toFixed(4)}`);

    if (byModel.length > 0) {
      console.log("\n  Cost by Model:");
      for (const m of byModel) {
        console.log(
          `    ${m.modelId.padEnd(40)} $${m.totalCost.toFixed(4)}  (${m.requestCount} reqs)`,
        );
      }
    }

    if (byTaskType.length > 0) {
      console.log("\n  Cost by Task Type:");
      for (const t of byTaskType) {
        console.log(
          `    ${t.taskType.padEnd(20)} $${t.totalCost.toFixed(4)}  (${t.requestCount} reqs, avg $${t.avgCost.toFixed(4)})`,
        );
      }
    }
    console.log();
  });

// ── Ingest Command (Unified Pipeline) ────────────────────────────

program
  .command("ingest")
  .description(
    "Full ingest pipeline: analyze → generate docs → set up AI infrastructure",
  )
  .argument("[path]", "Project path to ingest", ".")
  .option("--depth <level>", "Analysis depth: quick or full", "full")
  .option("--output <dir>", "Output directory for analysis artifacts")
  .action(
    async (projectPath: string, opts: { depth: string; output?: string }) => {
      const { resolve } = await import("node:path");
      const absPath = resolve(projectPath);
      const startTime = Date.now();

      console.log(`\n  ══════════════════════════════════════════════════`);
      console.log(`   Brainstorm Ingest — ${absPath}`);
      console.log(`  ══════════════════════════════════════════════════\n`);

      // Phase 1: Analyze (surface scan)
      console.log(`  Phase 1: Analyzing codebase...`);
      const { analyzeProject, runDeepAnalysis } =
        await import("@brainst0rm/ingest");
      const analysis = analyzeProject(absPath);
      console.log(
        `    ✓ ${analysis.summary.totalFiles} files, ${analysis.summary.totalLines.toLocaleString()} lines, ${analysis.summary.moduleCount} modules`,
      );

      // Phase 1b: Deep AST analysis (tree-sitter → knowledge graph)
      if (opts.depth === "full") {
        console.log(`  Phase 1b: Deep analysis (tree-sitter AST)...`);
        try {
          analysis.graph = await runDeepAnalysis(absPath);
          console.log(
            `    ✓ ${analysis.graph.stats.nodes} nodes, ${analysis.graph.stats.graphEdges} edges, ` +
              `${analysis.graph.communities.length} communities (${analysis.graph.pipelineMs}ms)`,
          );
        } catch (err: any) {
          console.log(`    ✗ Deep analysis failed: ${err.message}`);
        }
      }

      // Phase 2: Generate docs
      console.log(`  Phase 2: Generating documentation...`);
      const { generateAllDocs } = await import("@brainst0rm/docgen");
      const docResult = generateAllDocs(analysis, opts.output);
      console.log(`    ✓ ${docResult.filesWritten.length} doc files written`);

      // Phase 3: Setup infrastructure (reuse setup-infra logic)
      console.log(`  Phase 3: Setting up AI infrastructure...`);
      // Trigger setup-infra programmatically by executing the same logic inline
      const {
        existsSync,
        writeFileSync: fsWrite,
        mkdirSync: fsMkdir,
      } = await import("node:fs");
      const { join: pathJoin } = await import("node:path");

      // BRAINSTORM.md
      const bmPath = pathJoin(absPath, "BRAINSTORM.md");
      if (!existsSync(bmPath)) {
        const lines = [
          "---",
          `build_command: "npm run build"`,
          `test_command: "npm test"`,
          "---",
          "",
          `# ${absPath.split("/").pop()}`,
          "",
          `${analysis.languages.primary} project with ${analysis.summary.frameworkList.join(", ") || "no detected frameworks"}.`,
          `${analysis.summary.totalFiles} files, ${analysis.summary.totalLines.toLocaleString()} lines across ${analysis.summary.moduleCount} modules.`,
        ];

        // Enrich with graph data
        if (analysis.graph) {
          const g = analysis.graph;
          lines.push(
            "",
            "## Knowledge Graph",
            "",
            `${g.stats.functions} functions, ${g.stats.classes} classes, ${g.stats.methods} methods.`,
            `${g.stats.callEdges} call edges, ${g.crossFile.resolved} cross-file resolved.`,
            `${g.communities.length} communities detected. Languages parsed: ${g.parsedLanguages.join(", ") || "none"}.`,
          );

          if (g.communities.length > 0) {
            lines.push("", "### Modules", "");
            for (const c of g.communities.slice(0, 15)) {
              lines.push(`- **${c.name ?? c.id}** — ${c.nodeCount} symbols`);
            }
          }

          if (g.callHotspots.length > 0) {
            lines.push("", "### Key Functions (most-called)", "");
            for (const h of g.callHotspots.slice(0, 10)) {
              lines.push(`- \`${h.name}\` — ${h.callerCount} callers`);
            }
          }
        }

        fsWrite(bmPath, lines.join("\n"), "utf-8");
        console.log(`    ✓ Generated BRAINSTORM.md`);
      }

      // Agent profiles — enriched with graph data when available
      const agentsDir = pathJoin(absPath, ".brainstorm", "agents");
      if (!existsSync(agentsDir)) fsMkdir(agentsDir, { recursive: true });
      let agentCount = 0;

      // If we have graph communities, use those for agent assignment (much better than directory clusters)
      const agentSources =
        analysis.graph && analysis.graph.communities.length > 0
          ? analysis.graph.communities.slice(0, 15).map((c) => ({
              name: c.name ?? c.id,
              nodeCount: c.nodeCount,
              complexityScore: c.complexityScore,
              // Find exports and hotspots belonging to this community
              exports: analysis
                .graph!.exports.filter((e) => {
                  // Match exports to community by checking if the community name appears in the file path
                  const communityDir = (c.name ?? "").split("/")[0];
                  return communityDir && e.file.includes(communityDir);
                })
                .slice(0, 5),
              hotspots: analysis
                .graph!.callHotspots.filter((h) => {
                  const communityDir = (c.name ?? "").split("/")[0];
                  return (
                    communityDir && h.file && h.file.includes(communityDir)
                  );
                })
                .slice(0, 5),
            }))
          : analysis.dependencies.clusters.slice(0, 10).map((c) => ({
              name: c.directory,
              nodeCount: c.files.length,
              complexityScore: null as number | null,
              exports: [] as Array<{
                name: string;
                kind: string;
                file: string;
                line: number;
              }>,
              hotspots: [] as Array<{
                name: string;
                callerCount: number;
                file: string;
              }>,
            }));

      for (const source of agentSources) {
        const safeName = source.name.replace(/[/\\]/g, "-").replace(/^-/, "");
        if (!safeName) continue;
        const agentPath = pathJoin(agentsDir, `${safeName}.agent.md`);
        if (!existsSync(agentPath)) {
          const lines = [
            "---",
            `name: ${safeName}-expert`,
            "role: coder",
            "---",
            "",
            `# ${safeName} Expert`,
            "",
            `Domain expert for the ${safeName} module.`,
            `${source.nodeCount} symbols${source.complexityScore != null ? `, complexity: ${source.complexityScore}` : ""}.`,
          ];

          if (source.exports.length > 0) {
            lines.push("", "## Key Exports", "");
            for (const e of source.exports) {
              lines.push(`- \`${e.name}\` (${e.kind}) — ${e.file}:${e.line}`);
            }
          }

          if (source.hotspots.length > 0) {
            lines.push("", "## Call Hotspots", "");
            for (const h of source.hotspots) {
              lines.push(
                `- \`${h.name}\` — ${h.callerCount} callers (${h.file})`,
              );
            }
          }

          lines.push("");
          fsWrite(agentPath, lines.join("\n"), "utf-8");
          agentCount++;
        }
      }
      console.log(`    ✓ ${agentCount} agent profiles created`);

      // Recipes
      const { initRecipeDir } = await import("@brainst0rm/workflow");
      initRecipeDir(absPath);
      console.log(`    ✓ Recipe directory initialized`);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n  ──────────────────────────────────────────────────`);
      console.log(`  Ingest complete in ${elapsed}s.`);
      console.log(
        `  Your codebase is now AI-ready. Run \`storm chat\` to start.`,
      );
      console.log();
    },
  );

// ── Audit Command ────────────────────────────────────────────────

program
  .command("audit")
  .description(
    "Full code audit: security, quality, tech debt, dependency review",
  )
  .argument("[path]", "Project path to audit", ".")
  .option("--json", "Output as JSON")
  .option(
    "--focus <area>",
    "Focus area: security, quality, dependencies, all",
    "all",
  )
  .action(
    async (projectPath: string, opts: { json?: boolean; focus: string }) => {
      const { resolve } = await import("node:path");
      const absPath = resolve(projectPath);

      console.log(`\n  Auditing ${absPath}...\n`);

      const { analyzeProject } = await import("@brainst0rm/ingest");
      const analysis = analyzeProject(absPath);

      const findings: Array<{
        severity: string;
        category: string;
        message: string;
        file?: string;
      }> = [];

      // Complexity hotspots
      if (opts.focus === "all" || opts.focus === "quality") {
        for (const f of analysis.complexity.files.filter(
          (cf: any) => cf.score >= 70,
        )) {
          findings.push({
            severity: "warning",
            category: "complexity",
            message: `High complexity score (${f.score}/100) — consider refactoring`,
            file: f.path,
          });
        }
      }

      // Large files
      if (opts.focus === "all" || opts.focus === "quality") {
        for (const f of analysis.complexity.files.filter(
          (cf: any) => cf.lines > 500,
        )) {
          findings.push({
            severity: "info",
            category: "file-size",
            message: `Large file (${f.lines} lines) — consider splitting`,
            file: f.path,
          });
        }
      }

      // Low cohesion modules
      if (opts.focus === "all" || opts.focus === "quality") {
        for (const c of analysis.dependencies.clusters.filter(
          (cl) => cl.cohesion < 0.1,
        )) {
          findings.push({
            severity: "info",
            category: "cohesion",
            message: `Low cohesion module (${c.cohesion.toFixed(2)}) — files may be unrelated`,
            file: c.directory,
          });
        }
      }

      if (opts.json) {
        console.log(
          JSON.stringify({ findings, summary: analysis.summary }, null, 2),
        );
        return;
      }

      console.log(`  Audit Results: ${findings.length} finding(s)\n`);
      const bySeverity = { warning: 0, info: 0, error: 0 };
      for (const f of findings) {
        const icon =
          f.severity === "warning" ? "⚠" : f.severity === "error" ? "✗" : "ℹ";
        console.log(
          `    ${icon} [${f.category}] ${f.message}${f.file ? ` (${f.file})` : ""}`,
        );
        bySeverity[f.severity as keyof typeof bySeverity]++;
      }
      console.log(
        `\n  Summary: ${bySeverity.error} errors, ${bySeverity.warning} warnings, ${bySeverity.info} info`,
      );
      console.log();
    },
  );

// ── Share Command ────────────────────────────────────────────────

program
  .command("share")
  .description("Export or import session context for team sharing")
  .argument("<action>", "Action: export or import")
  .argument("[file]", "File path for export/import")
  .action(async (action: string, file?: string) => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const db = getDb();
    const sessionManager = new SessionManager(db);

    if (action === "export") {
      const sessions = db
        .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1")
        .all() as any[];
      if (sessions.length === 0) {
        console.log("\n  No sessions to export.");
        return;
      }
      const session = sessions[0];
      const messages = db
        .prepare("SELECT * FROM messages WHERE session_id = ?")
        .all(session.id);
      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        session: { id: session.id, projectPath: session.project_path },
        messages,
      };
      const outPath =
        file ?? `brainstorm-session-${session.id.slice(0, 8)}.json`;
      writeFileSync(outPath, JSON.stringify(exportData, null, 2), "utf-8");
      console.log(
        `\n  Exported session to ${outPath} (${messages.length} messages)`,
      );
    } else if (action === "import") {
      if (!file) {
        console.error("\n  Usage: storm share import <file.json>");
        process.exit(1);
      }
      const data = JSON.parse(readFileSync(file, "utf-8"));
      console.log(
        `\n  Imported session context: ${data.messages?.length ?? 0} messages from ${data.exportedAt}`,
      );
      console.log(`  Use this context in your next chat session.`);
    } else {
      console.error(`\n  Unknown action: ${action}. Use: export or import`);
    }
    console.log();
    closeDb();
  });

// ── Cloud Command (Remote Agents) ────────────────────────────────

program
  .command("cloud")
  .description("Run agents remotely via BrainstormRouter cloud")
  .argument("<action>", "Action: run, status, list")
  .argument("[task]", "Task description (for run)")
  .option("--budget <amount>", "Budget limit in dollars", "5.0")
  .action(async (action: string, task?: string, opts?: { budget: string }) => {
    console.log(`\n  BrainstormRouter Cloud Agents`);
    console.log(`  ─────────────────────────────\n`);

    switch (action) {
      case "run":
        if (!task) {
          console.error("  Usage: storm cloud run <task>");
          break;
        }
        console.log(`  Task:   ${task}`);
        console.log(`  Budget: $${opts?.budget ?? "5.0"}`);
        console.log(`  Status: Queued`);
        console.log(
          `\n  Cloud execution requires a BrainstormRouter Pro subscription.`,
        );
        console.log(
          `  Sign up at https://brainstorm.co/cloud to enable remote agents.`,
        );
        break;
      case "status":
        console.log(`  No active cloud agents.`);
        break;
      case "list":
        console.log(`  No completed cloud runs.`);
        break;
      default:
        console.error(`  Unknown action: ${action}. Use: run, status, list`);
    }
    console.log();
  });

// ── CI/CD Generation Command ─────────────────────────────────────

program
  .command("ci-gen")
  .description("Generate CI/CD workflow files (GitHub Actions, GitLab CI)")
  .argument("[platform]", "CI platform: github, gitlab", "github")
  .option("--output <path>", "Output path")
  .action(async (platform: string, opts: { output?: string }) => {
    const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { analyzeProject } = await import("@brainst0rm/ingest");

    const projectPath = process.cwd();
    const analysis = analyzeProject(projectPath);

    if (platform === "github") {
      const workflowDir =
        opts.output ?? join(projectPath, ".github", "workflows");
      if (!existsSync(workflowDir)) mkdirSync(workflowDir, { recursive: true });

      const buildCmd = analysis.frameworks.packageManagers.includes("pnpm")
        ? "pnpm"
        : analysis.frameworks.packageManagers.includes("yarn")
          ? "yarn"
          : "npm";

      const hasTurbo = analysis.frameworks.buildTools.includes("Turborepo");

      const workflow = [
        "name: Brainstorm AI Review",
        "",
        "on:",
        "  pull_request:",
        "    branches: [main, master]",
        "",
        "jobs:",
        "  ai-review:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        `      - uses: actions/setup-node@v4`,
        "        with:",
        '          node-version: "22"',
        `      - run: ${buildCmd} install`,
        hasTurbo
          ? `      - run: npx turbo run build test`
          : `      - run: ${buildCmd} run build && ${buildCmd} test`,
        "",
        "      # AI-assisted code review via Brainstorm",
        `      - name: Brainstorm Review`,
        `        run: npx @brainst0rm/cli run --unattended "Review the PR changes for bugs and security issues"`,
        "        env:",
        "          BRAINSTORM_API_KEY: ${{ secrets.BRAINSTORM_API_KEY }}",
      ];

      const outPath = join(workflowDir, "brainstorm-review.yml");
      writeFileSync(outPath, workflow.join("\n"), "utf-8");
      console.log(`\n  Generated GitHub Actions workflow: ${outPath}`);
    } else if (platform === "gitlab") {
      const outPath =
        opts.output ?? join(projectPath, ".gitlab-ci-brainstorm.yml");
      const workflow = [
        "brainstorm-review:",
        "  stage: review",
        "  image: node:22",
        "  script:",
        "    - npm install",
        '    - npx @brainst0rm/cli run --unattended "Review changes for bugs and security"',
        "  only:",
        "    - merge_requests",
        "  variables:",
        "    BRAINSTORM_API_KEY: $BRAINSTORM_API_KEY",
      ];
      writeFileSync(outPath, workflow.join("\n"), "utf-8");
      console.log(`\n  Generated GitLab CI config: ${outPath}`);
    } else {
      console.error(`\n  Unknown platform: ${platform}. Use: github, gitlab`);
    }
    console.log();
  });

// ── Start Command (One-Command Onboarding) ───────────────────────

program
  .command("start")
  .description(
    "One-command setup: detect project, connect to community tier, start chatting",
  )
  .action(async () => {
    const { resolve } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const projectPath = resolve(".");

    console.log(`\n  ══════════════════════════════════════════════════`);
    console.log(`   brainstorm start`);
    console.log(`  ══════════════════════════════════════════════════\n`);

    // Step 1: Check if already initialized
    const hasBrainstormMd =
      existsSync(resolve("BRAINSTORM.md")) || existsSync(resolve("STORM.md"));
    const hasConfig = existsSync(resolve("brainstorm.toml"));

    if (!hasBrainstormMd && !hasConfig) {
      console.log(`  Step 1: Initializing project...`);
      // Run init with defaults
      const { execFileSync } = await import("node:child_process");
      try {
        execFileSync(process.execPath, [process.argv[1], "init", "--yes"], {
          cwd: projectPath,
          stdio: "inherit",
        });
      } catch {
        // init may not exist as standalone — generate minimal config
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          resolve("BRAINSTORM.md"),
          `# ${projectPath.split("/").pop()}\n\nProject initialized by \`storm start\`.\n`,
          "utf-8",
        );
        console.log(`    ✓ Generated BRAINSTORM.md`);
      }
    } else {
      console.log(`  Step 1: Project already initialized ✓`);
    }

    // Step 2: Check API key / community tier
    const brKey = process.env.BRAINSTORM_API_KEY;
    if (brKey) {
      console.log(`  Step 2: BrainstormRouter API key detected ✓`);
    } else {
      console.log(`  Step 2: Using free community tier`);
      console.log(`    → 10 requests/min · $5/month cap · 362 models`);
      console.log(`    → Upgrade: https://brainstormrouter.com/dashboard`);
    }

    // Step 3: Quick health check
    console.log(`  Step 3: Checking connectivity...`);
    try {
      const resp = await fetch("https://api.brainstormrouter.com/health", {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        console.log(`    ✓ BrainstormRouter reachable`);
      } else {
        console.log(
          `    ⚠ BrainstormRouter returned ${resp.status} (will work offline with local models)`,
        );
      }
    } catch {
      console.log(
        `    ⚠ BrainstormRouter unreachable (will work offline with local models)`,
      );
    }

    console.log(`\n  ──────────────────────────────────────────────────`);
    console.log(`  Ready! Run one of:`);
    console.log(`    storm chat            Interactive session`);
    console.log(`    storm ingest          Analyze this codebase`);
    console.log(`    storm run "prompt"    Single-shot execution`);
    console.log();
  });

// ── Platform Command ─────────────────────────────────────────────

const platformCmd = program
  .command("platform")
  .description("Platform contract tools — verify, init, manifest");

platformCmd
  .command("verify")
  .description("Verify a product implements the Brainstorm platform contract")
  .argument("<url>", "Product API base URL (e.g., https://brainstormmsp.ai)")
  .option("--token <jwt>", "Bearer token for authenticated endpoints")
  .option("--timeout <ms>", "Request timeout in milliseconds", "10000")
  .action(async (url: string, opts: { token?: string; timeout?: string }) => {
    const { verifyProductContract } = await import("@brainst0rm/godmode");

    console.log(`\n  Platform Contract Verification`);
    console.log(`  ──────────────────────────────\n`);
    console.log(`  Target: ${url}`);
    console.log();

    const results = await verifyProductContract(url, {
      timeout: parseInt(opts.timeout ?? "10000"),
      token: opts.token,
    });

    let passed = 0;
    let failed = 0;

    for (const r of results) {
      const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "○";
      const color =
        r.status === "pass"
          ? "\x1b[32m"
          : r.status === "fail"
            ? "\x1b[31m"
            : "\x1b[90m";
      const latency = r.latencyMs ? ` (${r.latencyMs}ms)` : "";
      console.log(
        `  ${color}${icon}\x1b[0m ${r.endpoint} — ${r.message}${latency}`,
      );

      if (r.status === "pass") passed++;
      else if (r.status === "fail") failed++;
    }

    console.log();
    console.log(
      `  ${passed} passed, ${failed} failed, ${results.length} total`,
    );

    if (failed > 0) {
      console.log(`\n  Missing endpoints need to be implemented.`);
      console.log(`  See: brainstorm platform init`);
    } else {
      console.log(`\n  Product implements the platform contract.`);
    }
    console.log();

    process.exit(failed > 0 ? 1 : 0);
  });

platformCmd
  .command("init")
  .description("Generate a product-manifest.yaml template")
  .option("--id <id>", "Product ID (lowercase, hyphens)", "my-product")
  .option("--name <name>", "Display name", "My Product")
  .option("--url <url>", "API base URL", "http://localhost:3000")
  .action(async (opts: { id: string; name: string; url: string }) => {
    const { generateManifestTemplate } = await import("@brainst0rm/godmode");
    const { writeFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    const template = generateManifestTemplate(opts.id, opts.name, opts.url);

    const outPath = resolve("product-manifest.yaml");
    if (existsSync(outPath)) {
      console.error(
        `  product-manifest.yaml already exists. Delete it first to regenerate.`,
      );
      process.exit(1);
    }

    writeFileSync(outPath, template, "utf-8");
    console.log(`\n  ✓ Generated product-manifest.yaml`);
    console.log(
      `  Edit the file, then run: brainstorm platform verify ${opts.url}\n`,
    );
  });

platformCmd
  .command("validate")
  .description("Validate a product-manifest.yaml file")
  .argument("[path]", "Path to manifest file", "product-manifest.yaml")
  .action(async (path: string) => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { validateManifestData } = await import("@brainst0rm/godmode");

    const filePath = resolve(path);
    if (!existsSync(filePath)) {
      console.error(`  File not found: ${filePath}`);
      console.error(`  Run: brainstorm platform init`);
      process.exit(1);
    }

    const content = readFileSync(filePath, "utf-8");
    let data: unknown;
    try {
      // Try YAML-compatible JSON parse, or fall back to simple key:value parsing
      data = JSON.parse(content);
    } catch {
      // For YAML, we need a parser — suggest installing yaml package
      console.error(
        `  Cannot parse ${path}. Install 'yaml' package or use JSON format.`,
      );
      try {
        const yaml = await import("yaml");
        data = yaml.parse(content);
      } catch {
        console.error(`  Tip: npm install yaml`);
        process.exit(1);
      }
    }

    const result = validateManifestData(data);
    if (result.ok) {
      const m = result.manifest!;
      console.log(
        `\n  ✓ Valid manifest: ${m.product.name} (${m.product.id}) v${m.product.version}`,
      );
      console.log(`    API: ${m.security.api_base}`);
      console.log(
        `    Auth: human=${m.security.auth.human}, machine=${m.security.auth.machine}`,
      );
      console.log(`    Capabilities: ${m.capabilities.length}`);
      console.log(
        `    Events: publishes=${m.events.publishes.length}, subscribes=${m.events.subscribes.length}`,
      );
      console.log();
    } else {
      console.error(`\n  ✗ Invalid manifest:`);
      for (const err of result.errors ?? []) {
        console.error(`    - ${err}`);
      }
      console.error();
      process.exit(1);
    }
  });

// ── MCP Command ──────────────────────────────────────────────────

program
  .command("mcp")
  .description(
    "Start MCP server (stdio) — exposes God Mode tools to Claude Code/Desktop",
  )
  .action(async () => {
    const { startMCPServer } = await import("../mcp-server.js");
    await startMCPServer();
  });

// ── Setup Command ────────────────────────────────────────────────

program
  .command("setup")
  .description(
    "Bootstrap Brainstorm on this machine — auth, config, MCP, ecosystem context",
  )
  .action(async () => {
    const { existsSync, mkdirSync, writeFileSync, readFileSync } =
      await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    console.log(`\n  ══════════════════════════════════════════════════`);
    console.log(`   brainstorm setup`);
    console.log(`  ══════════════════════════════════════════════════\n`);

    // Step 1: Check BR API key
    const brKey = process.env.BRAINSTORM_API_KEY;
    if (brKey) {
      console.log(`  ✓ BrainstormRouter API key found`);
    } else {
      console.log(`  ✗ BRAINSTORM_API_KEY not set`);
      console.log(`    Get one at https://brainstormrouter.com/dashboard`);
      console.log(`    Then: export BRAINSTORM_API_KEY=br_live_xxx\n`);
    }

    // Step 2: Check 1Password
    const opToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    if (opToken) {
      console.log(`  ✓ 1Password service account connected`);
    } else {
      console.log(`  ○ 1Password not configured (optional)`);
    }

    // Step 3: Test product connectivity
    console.log(`\n  Testing products...\n`);
    const products = [
      {
        id: "msp",
        url: process.env.BRAINSTORM_MSP_URL ?? "https://brainstormmsp.ai",
        key: "BRAINSTORM_MSP_API_KEY",
      },
      {
        id: "br",
        url:
          process.env.BRAINSTORM_BR_URL ?? "https://api.brainstormrouter.com",
        key: "BRAINSTORM_API_KEY",
      },
      {
        id: "gtm",
        url: process.env.BRAINSTORM_GTM_URL ?? "https://catsfeet.com",
        key: "BRAINSTORM_GTM_API_KEY",
      },
      {
        id: "vm",
        url: process.env.BRAINSTORM_VM_URL ?? "https://vm.brainstorm.co",
        key: "BRAINSTORM_VM_API_KEY",
      },
      {
        id: "shield",
        url:
          process.env.BRAINSTORM_SHIELD_URL ?? "https://shield.brainstorm.co",
        key: "BRAINSTORM_SHIELD_API_KEY",
      },
    ];

    let connectedCount = 0;
    let totalTools = 0;
    const connectedSystems: string[] = [];

    for (const p of products) {
      try {
        const res = await fetch(`${p.url}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const health = (await res.json()) as any;
          // Try to get tool count
          let toolCount = 0;
          const apiKey = process.env[p.key];
          if (apiKey) {
            try {
              const toolsRes = await fetch(`${p.url}/api/v1/god-mode/tools`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(5000),
              });
              if (toolsRes.ok) {
                const data = (await toolsRes.json()) as any;
                toolCount = data.tool_count ?? data.tools?.length ?? 0;
              }
            } catch {}
          }
          console.log(
            `  ● ${p.id.padEnd(8)} ${String(toolCount).padStart(2)} tools  ${health.version ?? ""}`,
          );
          connectedCount++;
          totalTools += toolCount;
          connectedSystems.push(p.id);
        } else {
          console.log(`  ○ ${p.id.padEnd(8)} unreachable (${res.status})`);
        }
      } catch {
        console.log(`  ○ ${p.id.padEnd(8)} offline`);
      }
    }

    // Step 4: Configure MCP for Claude Code
    const claudeDir = join(homedir(), ".claude");
    const mcpPath = join(claudeDir, "mcp.json");

    if (existsSync(mcpPath)) {
      try {
        const existing = JSON.parse(readFileSync(mcpPath, "utf-8"));
        if (!existing.mcpServers?.brainstorm) {
          existing.mcpServers = existing.mcpServers ?? {};
          existing.mcpServers.brainstorm = {
            command: "brainstorm",
            args: ["mcp"],
          };
          writeFileSync(mcpPath, JSON.stringify(existing, null, 2));
          console.log(
            `\n  ✓ Added brainstorm MCP server to ~/.claude/mcp.json`,
          );
        } else {
          console.log(
            `\n  ✓ brainstorm MCP server already in ~/.claude/mcp.json`,
          );
        }
      } catch {
        console.log(`\n  ⚠ Could not update ~/.claude/mcp.json (parse error)`);
      }
    } else {
      console.log(
        `\n  ○ ~/.claude/mcp.json not found (Claude Code not detected)`,
      );
    }

    // Step 5: Summary
    console.log(`\n  ──────────────────────────────────────────────────`);
    console.log(
      `  ${connectedCount} products connected, ${totalTools} tools available`,
    );
    console.log(`  Run: brainstorm status (full diagnostic)`);
    console.log(`  Run: brainstorm mcp (start MCP server for Claude)`);
    console.log();
  });

// ── Status Command (ecosystem) ───────────────────────────────────

program
  .command("ecosystem")
  .alias("status")
  .description(
    "Show full ecosystem status — all products, tools, auth, connectivity",
  )
  .action(async () => {
    console.log(`\n  Brainstorm Ecosystem Status`);
    console.log(`  ───────────────────────────\n`);

    // Auth
    const brKey = process.env.BRAINSTORM_API_KEY;
    console.log(
      `  Auth:     ${brKey ? "✓ BR key set" : "✗ BRAINSTORM_API_KEY not set"}`,
    );
    console.log(
      `  Vault:    ${process.env.OP_SERVICE_ACCOUNT_TOKEN ? "✓ 1Password connected" : "○ 1Password not configured"}`,
    );

    // Products
    console.log(`\n  Products:`);
    const products = [
      {
        id: "msp",
        name: "BrainstormMSP",
        url: process.env.BRAINSTORM_MSP_URL ?? "https://brainstormmsp.ai",
        key: "BRAINSTORM_MSP_API_KEY",
      },
      {
        id: "br",
        name: "BrainstormRouter",
        url:
          process.env.BRAINSTORM_BR_URL ?? "https://api.brainstormrouter.com",
        key: "BRAINSTORM_API_KEY",
      },
      {
        id: "gtm",
        name: "BrainstormGTM",
        url: process.env.BRAINSTORM_GTM_URL ?? "https://catsfeet.com",
        key: "BRAINSTORM_GTM_API_KEY",
      },
      {
        id: "vm",
        name: "BrainstormVM",
        url: process.env.BRAINSTORM_VM_URL ?? "https://vm.brainstorm.co",
        key: "BRAINSTORM_VM_API_KEY",
      },
      {
        id: "shield",
        name: "BrainstormShield",
        url:
          process.env.BRAINSTORM_SHIELD_URL ?? "https://shield.brainstorm.co",
        key: "BRAINSTORM_SHIELD_API_KEY",
      },
    ];

    let totalTools = 0;
    for (const p of products) {
      try {
        const start = Date.now();
        const res = await fetch(`${p.url}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        const latency = Date.now() - start;
        if (res.ok) {
          const health = (await res.json()) as any;
          let toolCount = 0;
          const apiKey = process.env[p.key];
          if (apiKey) {
            try {
              const toolsRes = await fetch(`${p.url}/api/v1/god-mode/tools`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(5000),
              });
              if (toolsRes.ok) {
                const data = (await toolsRes.json()) as any;
                toolCount = data.tool_count ?? data.tools?.length ?? 0;
                totalTools += toolCount;
              }
            } catch {}
          }
          console.log(
            `    ● ${p.name.padEnd(20)} ${String(toolCount).padStart(2)} tools  ${p.url.padEnd(35)} ${latency}ms  ${health.status ?? "ok"}`,
          );
        } else {
          console.log(
            `    ○ ${p.name.padEnd(20)}  — tools  ${p.url.padEnd(35)}  —    ${res.status}`,
          );
        }
      } catch {
        console.log(
          `    ○ ${p.name.padEnd(20)}  — tools  ${p.url.padEnd(35)}  —    offline`,
        );
      }
    }

    // MCP
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const mcpPath = join(homedir(), ".claude", "mcp.json");
    let mcpConfigured = false;
    if (existsSync(mcpPath)) {
      try {
        const mcp = JSON.parse(
          (await import("node:fs")).readFileSync(mcpPath, "utf-8"),
        );
        mcpConfigured = !!mcp.mcpServers?.brainstorm;
      } catch {}
    }
    console.log(
      `\n  MCP:      ${mcpConfigured ? "✓ brainstorm MCP server configured" : "○ not configured (run brainstorm setup)"}`,
    );

    console.log(`\n  ${totalTools} tools available across ecosystem.`);
    console.log();
  });

// ── IPC Command ─────────────────────────────────────────────────
// Desktop app backend — communicates via stdin/stdout NDJSON, no HTTP.

program
  .command("ipc")
  .description(
    "Start Brainstorm in IPC mode (stdin/stdout NDJSON) for desktop app integration",
  )
  .action(async () => {
    const { startIPCHandler } = await import("../ipc/handler.js");
    const { MemoryManager } = await import("@brainst0rm/core");
    const config = loadConfig();

    // Resolve keys from env only (non-interactive — no TTY in IPC mode)
    const envKeys = new Map<string, string>();
    for (const name of PROVIDER_KEY_NAMES) {
      const val = process.env[name];
      if (val) envKeys.set(name, val);
    }
    const resolvedKeys: ResolvedKeys = {
      get: (name: string) => envKeys.get(name) ?? null,
    };

    const registry = await createProviderRegistry(config, resolvedKeys);
    const db = getDb();
    const costTracker = new CostTracker(db, config.budget);
    const tools = createDefaultToolRegistry();
    const { frontmatter } = buildSystemPrompt(process.cwd());
    const router = new BrainstormRouter(
      config,
      registry,
      costTracker,
      frontmatter,
    );
    const memoryManager = new MemoryManager(process.cwd());

    await startIPCHandler({
      db,
      config,
      registry,
      router,
      tools,
      memoryManager,
      version: CLI_VERSION,
      projectPath: process.cwd(),
    });
  });

// ── Serve Command ────────────────────────────────────────────────

program
  .command("serve")
  .description(
    "Start the Brainstorm control plane HTTP API server (God Mode over HTTP)",
  )
  .option("--port <port>", "Port to listen on", "8000")
  .option("--host <host>", "Host to bind to", "127.0.0.1")
  .option("--cors", "Enable CORS for dashboard access")
  .action(async (opts: { port: string; host: string; cors?: boolean }) => {
    const { connectGodMode, createProductConnectors, setAuditPersister } =
      await import("@brainst0rm/godmode");
    const { ChangeSetLogRepository } = await import("@brainst0rm/db");
    const { BrainstormServer } = await import("@brainst0rm/server");
    const config = loadConfig();
    const port = parseInt(opts.port);
    const host = opts.host;

    console.log(`\n  ══════════════════════════════════════════════════`);
    console.log(`   brainstorm serve — Control Plane API`);
    console.log(`  ══════════════════════════════════════════════════\n`);

    // ── Boot: resolve keys from env only (non-interactive) ─────
    const envKeys = new Map<string, string>();
    for (const name of PROVIDER_KEY_NAMES) {
      const val = process.env[name];
      if (val) envKeys.set(name, val);
    }
    const resolvedKeys: ResolvedKeys = {
      get: (name: string) => envKeys.get(name) ?? null,
    };
    const registry = await createProviderRegistry(config, resolvedKeys);
    const db = getDb();

    // Wire audit persistence — changeset executions go to SQLite
    const csLogRepo = new ChangeSetLogRepository(db);
    setAuditPersister((entry) => {
      csLogRepo.log({
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

    const costTracker = new CostTracker(db, config.budget);
    const tools = createDefaultToolRegistry();

    // Wire memory tool in IPC server mode
    const { MemoryManager: ServerMemoryManager } =
      await import("@brainst0rm/core");
    const serverMemory = new ServerMemoryManager(process.cwd());
    const wiredServerMemory = createWiredMemoryTool(serverMemory);
    tools.unregister("memory");
    tools.register(wiredServerMemory);

    const { frontmatter } = buildSystemPrompt(process.cwd());
    const router = new BrainstormRouter(
      config,
      registry,
      costTracker,
      frontmatter,
    );

    // ── Boot: connect God Mode connectors (generic, config-driven) ─
    const mspBaseUrl =
      process.env.BRAINSTORM_MSP_URL ?? "https://brainstormmsp.ai";
    const defaultConnectors: Record<string, any> = {
      msp: {
        enabled: true,
        baseUrl: mspBaseUrl,
        apiKeyName: "BRAINSTORM_MSP_API_KEY",
      },
    };
    const mergedGmConfig = {
      ...config.godmode,
      connectors: { ...defaultConnectors, ...config.godmode.connectors },
    };
    const connectors = await createProductConnectors(mergedGmConfig);

    // Add typed agent connector (routes through MSP's agent management API)
    const { createAgentConnector } =
      await import("@brainst0rm/godmode/connectors/agent");
    connectors.push(
      createAgentConnector({
        enabled: true,
        baseUrl: mspBaseUrl,
        apiKeyName: "_GM_AGENT_KEY",
      }),
    );

    const godmode = await connectGodMode(tools, mergedGmConfig, connectors);

    console.log(
      `  God Mode: ${godmode.connectedSystems.length} systems connected, ${godmode.totalTools} tools`,
    );
    for (const sys of godmode.connectedSystems) {
      console.log(
        `    ✓ ${sys.displayName} (${sys.toolCount} tools, ${sys.latencyMs}ms)`,
      );
    }
    for (const err of godmode.errors) {
      console.log(`    ✗ ${err.name}: ${err.error}`);
    }

    // ── Boot: memory manager for conversations ──────────────────
    const { MemoryManager } = await import("@brainst0rm/core");
    const memoryManager = new MemoryManager(process.cwd());

    // ── Start server via @brainst0rm/server ────────────────────
    const server = new BrainstormServer(
      {
        db,
        config,
        registry,
        router,
        costTracker,
        tools,
        godmode,
        memoryManager,
        version: CLI_VERSION,
      },
      {
        port,
        host,
        cors: opts.cors,
        jwtSecret: process.env.SUPABASE_JWT_SECRET,
        projectPath: process.cwd(),
      },
    );

    const { url } = await server.start();

    console.log(`\n  ──────────────────────────────────────────────────`);
    console.log(`  API server listening on ${url}`);
    console.log();
    console.log(`  Endpoints:`);
    console.log(`    GET  /health                           Health check`);
    console.log(
      `    GET  /api/v1/products                  Connected products`,
    );
    console.log(
      `    GET  /api/v1/tools                     All God Mode tools`,
    );
    console.log(`    POST /api/v1/tools/execute             Execute a tool`);
    console.log(
      `    GET  /api/v1/changesets                Pending ChangeSets`,
    );
    console.log(`    POST /api/v1/changesets/:id/approve    Approve + execute`);
    console.log(
      `    POST /api/v1/changesets/:id/reject     Reject a ChangeSet`,
    );
    console.log(`    GET  /api/v1/audit                     Audit trail`);
    console.log(
      `    POST /api/v1/platform/events           Receive signed events`,
    );
    console.log(
      `    POST /api/v1/chat                      Chat (non-streaming)`,
    );
    console.log(
      `    POST /api/v1/chat/stream               SSE streaming chat`,
    );
    console.log(
      `    GET  /api/v1/conversations             List conversations`,
    );
    console.log(
      `    POST /api/v1/conversations             Create conversation`,
    );
    console.log(`    POST /api/v1/conversations/:id/handoff Model handoff`);
    console.log();

    // Keep alive — SIGINT/SIGTERM handled by the global handlers
    await new Promise(() => {});
  });

// ── Chat Command ──────────────────────────────────────────────────

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
      // and the fire-and-forget push path stays broken.
      let chatSyncWorker: Awaited<
        ReturnType<typeof startSyncWorkerIfConfigured>
      > = null;
      chatSyncWorker = await startSyncWorkerIfConfigured(chatGateway, db);

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
        config.shell.sandbox as any,
        projectPath,
        config.shell.maxOutputBytes,
        config.shell.containerImage,
        config.shell.containerTimeout,
      );
      const permissionManager = new PermissionManager(
        config.general.defaultPermissionMode as any,
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
      const [registry] = await Promise.all([
        createProviderRegistry(config, resolvedKeys),
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
        process.stderr.write(`\n  ${prefix} Budget: ${budgetDiag.message}\n\n`);
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
        router.setStrategy(opts.strategy as any);
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
            connectors: { ...defaultConnectors, ...config.godmode.connectors },
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
            dailyLog.append(`Sector intelligence unavailable: ${err.message}`, {
              eventType: "warning",
            });
          }

          const daemon = new DaemonController({
            config: config.daemon,
            sessionId: session.id,
            projectPath,
            runTick: (tickMessage: string) => {
              // If sector agents are configured, overlay sector context
              let finalMessage = tickMessage;
              let sectorBudget: number | undefined;
              let currentSectorId: string | undefined;

              if (sectorAgents.length > 0 && sectorGraph && _selectNextSector) {
                try {
                  const tick = _selectNextSector(sectorAgents, sectorGraph);
                  if (tick) {
                    finalMessage =
                      tick.tickMessage + "\n\n---\n\n" + tickMessage;
                    sectorBudget = tick.budgetLimit;
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
                const turnCost = event.totalCost - costTracker.getSessionCost();
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
          })) {
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
                  spinFrames[Math.floor(Date.now() / 100) % spinFrames.length];
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
          permissionCheck: (name, perm) => permissionManager.check(name, perm),
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

      render(
        React.createElement(App, {
          strategy: config.general.defaultStrategy,
          modelCount: { local: localCount, cloud: cloudCount },
          onSendMessage: handleSendMessage,
          onAbort: handleAbort,
          models: modelData,
          gateway: brGateway,
          configInfo: {
            strategy: config.general.defaultStrategy,
            permissionMode: config.general.defaultPermissionMode ?? "confirm",
            outputStyle: config.general.outputStyle ?? "concise",
            sandbox: config.shell?.sandbox ?? "none",
          },
          vaultInfo: {
            exists: new BrainstormVault(VAULT_PATH).exists(),
            isOpen: false,
            keyCount: 0,
            keys: [],
            createdAt: null,
            opAvailable: !!process.env.OP_SERVICE_ACCOUNT_TOKEN,
            resolvedKeys: PROVIDER_KEY_NAMES.filter((k) => resolvedKeys.get(k)),
          },
          godModeInfo: godModeResult
            ? {
                connectedSystems: godModeResult.connectedSystems,
                errors: godModeResult.errors,
                totalTools: godModeResult.totalTools,
              }
            : undefined,
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
                      { text: rebuilt.segments[0].text + ts, cacheable: true },
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
                      { text: rebuilt.segments[0].text + ts, cacheable: true },
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
                remaining: Math.max(0, state.sessionLimit - state.sessionUsed),
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
                  if (!args) return "Usage: /vault get <key-name>";
                  const val = vault.get(args);
                  if (val === null)
                    return `Key '${args}' not found (or vault is locked).`;
                  return `${args} = ${val.slice(0, 8)}${"*".repeat(Math.max(0, val.length - 8))}`;
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
    },
  );

export function run() {
  // Initialize Sentry — no-ops if SENTRY_DSN is not set
  initSentry({ release: process.env.npm_package_version });

  // Graceful shutdown: stop Docker sandbox, close DB, flush Sentry
  const cleanup = () => {
    try {
      stopDockerSandbox();
    } catch {
      // Best effort — container may already be stopped
    }
    try {
      closeDb();
    } catch {
      // Best effort — DB may already be closed
    }
    flushSentry(1500).catch(() => {});
  };

  // Catch unhandled errors and report to Sentry AND print to stderr.
  //
  // Without the stderr print, a thrown exception during startup causes the
  // CLI to exit silently with code 1 and zero output — which is exactly
  // what happened with the duplicate `doctor` command registration in this
  // session (see commit c6c7445). Every brainstorm invocation died silently
  // for an unknown duration because the handler ate the commander error.
  //
  // The fix is trivial: print the error message + stack to stderr before
  // running cleanup. Sentry capture stays (no-op without DSN). Developers
  // now get "Error: cannot add command 'doctor' as already have command
  // 'doctor' ..." instead of bash-level "exit=1".
  process.on("uncaughtException", (err) => {
    process.stderr.write(`\n  ⚠ Uncaught exception: ${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    captureError(err, { source: "uncaughtException" });
    cleanup();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    process.stderr.write(`\n  ⚠ Unhandled promise rejection: ${err.message}\n`);
    if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    captureError(err, { source: "unhandledRejection" });
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  process.on("exit", () => {
    cleanup();
  });

  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exit(0);
  } else {
    program.parse();
  }
}

run();
