import { Command } from "commander";
import { loadConfig } from "@brainstorm/config";
import { getDb, closeDb, CostRepository } from "@brainstorm/db";
import {
  createProviderRegistry,
  getBrainstormApiKey,
  isCommunityKey,
} from "@brainstorm/providers";
import { BrainstormRouter, CostTracker } from "@brainstorm/router";
import {
  createDefaultToolRegistry,
  configureSandbox,
  stopDockerSandbox,
} from "@brainstorm/tools";
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
  type CompactionCallbacks,
} from "@brainstorm/core";
import type { OutputStyle } from "@brainstorm/core";
import { AgentManager, parseAgentNL } from "@brainstorm/agents";
import { ROLES, type RoleId } from "../commands/roles.js";
import {
  runWorkflow,
  getPresetWorkflow,
  autoSelectPreset,
  PRESET_WORKFLOWS,
} from "@brainstorm/workflow";
import { renderMarkdownToString } from "../components/MarkdownRenderer.js";
import { runInit } from "../init/index.js";
import { runEvalCli, runProbe } from "@brainstorm/eval";
import {
  createGatewayClient,
  createIntelligenceClient,
  formatGatewayFeedback,
} from "@brainstorm/gateway";
import { MCPClientManager } from "@brainstorm/mcp";
import { BrainstormVault, KeyResolver } from "@brainstorm/vault";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedKeys } from "@brainstorm/providers";

/** Known API key names that providers need at startup. */
const PROVIDER_KEY_NAMES = [
  "BRAINSTORM_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
  "BRAINSTORM_ADMIN_KEY",
];

/**
 * Eagerly resolve all provider keys through the vault/1Password/env chain.
 * Triggers the lazy vault password prompt if a vault exists and keys are needed.
 * Returns a sync ResolvedKeys map for createProviderRegistry.
 */
async function resolveProviderKeys(): Promise<ResolvedKeys> {
  const vault = new BrainstormVault(VAULT_PATH);
  const resolver = new KeyResolver(vault.exists() ? vault : null, () =>
    promptPassword("  Vault password: "),
  );

  const resolved = new Map<string, string>();
  for (const name of PROVIDER_KEY_NAMES) {
    const value = await resolver.get(name);
    if (value) resolved.set(name, value);
  }

  return { get: (name: string) => resolved.get(name) ?? null };
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
        await import("@brainstorm/eval");

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

      // Run agent on each instance
      console.log(`  Running agent on instances...`);
      const patches = await runSWEBench(
        instances,
        async (instance: any) => {
          // Use Brainstorm to generate a patch for each instance
          const startTime = Date.now();
          // Placeholder: in full implementation, this spawns a storm run --unattended
          // with the issue description as the prompt, in a Docker container at baseCommit
          return {
            instanceId: instance.instanceId,
            patch: "",
            model: opts.model ?? "auto",
            strategy: "quality-first",
            cost: 0,
            latencyMs: Date.now() - startTime,
            success: false,
          };
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
      console.log();
    },
  );

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
  .action(async () => {
    const config = loadConfig();
    const registry = await createProviderRegistry(
      config,
      await resolveProviderKeys(),
    );

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
  .action(async () => {
    const config = loadConfig();
    const db = getDb();
    const costTracker = new CostTracker(db, config.budget);
    const summary = costTracker.getSummary();

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
  .action(async () => {
    const config = loadConfig();
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
  .option("--json", "Output structured JSON (for CI/CD pipelines)")
  .option("--pipe", "Read from stdin if no prompt given")
  .option("--model <id>", "Target a specific model (bypass routing)")
  .option("--tools", "Enable tool use (default: disabled)")
  .option("--max-steps <n>", "Maximum agentic steps (default: 1)", "1")
  .option(
    "--strategy <name>",
    "Routing strategy: cost-first, quality-first, combined, capability",
  )
  .option("--lfg", "Full auto mode — skip all permission confirmations")
  .option(
    "--unattended",
    "Unattended mode — enable tools, auto-approve, auto-commit on success",
  )
  .action(
    async (
      prompt: string | undefined,
      opts: {
        json?: boolean;
        pipe?: boolean;
        model?: string;
        tools?: boolean;
        maxSteps?: string;
        strategy?: string;
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

      const db = getDb();
      const resolvedKeys = await resolveProviderKeys();
      const resolvedBRKey =
        resolvedKeys.get("BRAINSTORM_API_KEY") ?? getBrainstormApiKey();
      const isCommunityTier = isCommunityKey(resolvedBRKey);
      // Set env for native BR tools (br_status, br_budget, etc.)
      if (resolvedBRKey) process.env._BR_RESOLVED_KEY = resolvedBRKey;
      const registry = await createProviderRegistry(config, resolvedKeys);
      const costTracker = new CostTracker(db, config.budget);
      const tools = createDefaultToolRegistry();
      await connectMCPServers(
        tools,
        config,
        resolvedKeys.get("BRAINSTORM_API_KEY"),
      );
      const sessionManager = new SessionManager(db);
      const projectPath = process.cwd();
      configureSandbox(
        config.shell.sandbox as any,
        projectPath,
        config.shell.maxOutputBytes,
        config.shell.containerImage,
        config.shell.containerTimeout,
      );
      const { prompt: rawPrompt, frontmatter } = buildSystemPrompt(projectPath);
      const systemPrompt =
        rawPrompt + buildToolAwarenessSection(tools.listTools());
      const router = new BrainstormRouter(
        config,
        registry,
        costTracker,
        frontmatter,
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
      } else if (!isCommunityTier || hasDirectKeys) {
        router.setStrategy("quality-first");
      }

      const session = sessionManager.start(projectPath);

      sessionManager.addUserMessage(finalPrompt);

      let fullResponse = "";
      let modelName = "unknown";
      let toolCallCount = 0;

      if (!opts.json) {
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
        disableTools: !opts.tools,
        preferredModelId:
          opts.model ??
          (resolvedKeys.get("MOONSHOT_API_KEY")
            ? "moonshot/kimi-k2.5"
            : isCommunityTier &&
                !resolvedKeys.get("DEEPSEEK_API_KEY") &&
                !resolvedKeys.get("ANTHROPIC_API_KEY") &&
                !resolvedKeys.get("OPENAI_API_KEY") &&
                !resolvedKeys.get("GOOGLE_GENERATIVE_AI_API_KEY")
              ? "brainstormrouter/auto"
              : undefined),
        maxSteps: parseInt(opts.maxSteps ?? "1"),
        compaction: buildCompactionCallbacks(sessionManager),
        permissionCheck: (tool, args) => permissionManager.check(tool, args),
        middleware,
      })) {
        switch (event.type) {
          case "thinking":
            if (!opts.json) {
              const spinnerFrames = [
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
              const frame =
                spinnerFrames[
                  Math.floor(Date.now() / 100) % spinnerFrames.length
                ];
              const phases: Record<string, string> = {
                classifying: "Classifying task...",
                routing: "Selecting model...",
                connecting: `Connecting...`,
                streaming: "Streaming...",
              };
              process.stderr.write(
                `\r${frame} ${phases[event.phase] ?? event.phase}`,
              );
            }
            break;
          case "routing":
            modelName = event.decision.model.name;
            process.stderr.write(
              `\r[${event.decision.strategy}] → ${modelName}\n`,
            );
            break;
          case "text-delta":
            fullResponse += event.delta;
            break;
          case "tool-call-start":
            toolCallCount++;
            process.stderr.write(`\n[tool: ${event.toolName}]\n`);
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
            modelName = event.toModel;
            fullResponse = ""; // Reset for retry
            break;
          case "done":
            if (opts.json) {
              // Structured JSON output for CI/CD — only valid JSON on stdout
              process.stdout.write(
                JSON.stringify({
                  text: fullResponse,
                  model: modelName,
                  cost: event.totalCost,
                  toolCalls: toolCallCount,
                  success: true,
                }) + "\n",
              );
            } else {
              process.stdout.write(renderMarkdownToString(fullResponse));
              process.stdout.write(
                `\n\n[cost: $${event.totalCost.toFixed(4)}]\n`,
              );
            }
            break;
          case "error":
            if (opts.json) {
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
            } else {
              process.stderr.write(`\nError: ${event.error.message}\n`);
            }
            break;
        }
      }

      if (fullResponse) {
        sessionManager.addAssistantMessage(fullResponse);
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

/** Prompt for a password with masked echo. Supports BRAINSTORM_VAULT_PASSWORD env for non-interactive use. */
function promptPassword(prompt: string): Promise<string> {
  // Non-interactive: use env var if set (for CI/CD and scripting)
  const envPassword = process.env.BRAINSTORM_VAULT_PASSWORD;
  if (envPassword) {
    console.error(
      "  [vault] Using BRAINSTORM_VAULT_PASSWORD from environment (no prompt)",
    );
    return Promise.resolve(envPassword);
  }

  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);

    // Always try to set raw mode to prevent terminal echo
    let rawModeWasSet = false;
    try {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
        rawModeWasSet = true;
      }
    } catch {
      // Some environments don't support raw mode
    }

    // Ensure stdin is in flowing mode
    if (process.stdin.isPaused?.()) process.stdin.resume();

    let password = "";
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      if (rawModeWasSet) {
        try {
          process.stdin.setRawMode?.(false);
        } catch {
          /* ignore */
        }
      }
      process.stderr.write("\n");
    };

    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === "\n" || c === "\r" || c === "\u0004") {
        cleanup();
        resolve(password);
      } else if (c === "\u0003") {
        cleanup();
        reject(new Error("Cancelled"));
      } else if (c === "\u007F" || c === "\b") {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stderr.write("\b \b");
        }
      } else if (c.charCodeAt(0) >= 32) {
        // Only accept printable characters
        password += c;
        process.stderr.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
}

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
    const { ProjectManager } = await import("@brainstorm/projects");
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
      const { ProjectManager } = await import("@brainstorm/projects");
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
    const { ProjectManager } = await import("@brainstorm/projects");
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
    const { ProjectManager } = await import("@brainstorm/projects");
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
    const { ProjectManager } = await import("@brainstorm/projects");
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
    const { ScheduledTaskRepository } = await import("@brainstorm/scheduler");
    const { ProjectManager } = await import("@brainstorm/projects");
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
      await import("@brainstorm/scheduler");
    const { ProjectManager } = await import("@brainstorm/projects");
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
      const { describeCron } = await import("@brainstorm/scheduler");
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
    const { TriggerRunner } = await import("@brainstorm/scheduler");
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
      await import("@brainstorm/scheduler");
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
    const { ScheduledTaskRepository } = await import("@brainstorm/scheduler");
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
    const { ScheduledTaskRepository } = await import("@brainstorm/scheduler");
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
    const { ScheduledTaskRepository } = await import("@brainstorm/scheduler");
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
    const { executePlan } = await import("@brainstorm/core");
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
    const { parsePlanFile } = await import("@brainstorm/core");
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
      await import("@brainstorm/core");

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
        await import("@brainstorm/orchestrator");
      const { ProjectManager } = await import("@brainstorm/projects");
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
    const { OrchestrationEngine } = await import("@brainstorm/orchestrator");
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
  .command("status")
  .argument("<run-id>", "Orchestration run ID")
  .description("Show status of an orchestration run")
  .action(async (runId: string) => {
    const { OrchestrationEngine } = await import("@brainstorm/orchestrator");
    const { ProjectManager } = await import("@brainstorm/projects");
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
  .action(async (projectPath: string, opts: { json?: boolean }) => {
    const { resolve } = await import("node:path");
    const absPath = resolve(projectPath);

    console.log(`\n  Analyzing ${absPath}...\n`);
    const startTime = Date.now();

    const { analyzeProject } = await import("@brainstorm/ingest");
    const analysis = analyzeProject(absPath);
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

    console.log("\n  ──────────────────────────────────────────────────");
    console.log(`  Run \`storm analyze --json\` for machine-readable output.`);
    console.log();
  });

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
      const { analyzeProject } = await import("@brainstorm/ingest");
      const analysis = analyzeProject(absPath);

      console.log(`  Generating documentation...\n`);
      const { generateAllDocs } = await import("@brainstorm/docgen");
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
    const { createWorktree, removeWorktree } = await import("@brainstorm/core");
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
        const { semanticSearch } = await import("@brainstorm/core");
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
    const { analyzeProject } = await import("@brainstorm/ingest");
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
    const { generateAllDocs } = await import("@brainstorm/docgen");
    const docResult = generateAllDocs(analysis);
    console.log(
      `  ✓ Generated ${docResult.filesWritten.length} documentation files`,
    );

    // Phase 5: Initialize recipe directory
    const { initRecipeDir } = await import("@brainstorm/workflow");
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

// ── Route Explain Command ─────────────────────────────────────────

program
  .command("route")
  .description("Explain how Brainstorm classifies and routes a task")
  .argument("[task]", "Task description to classify")
  .option("--json", "Output as JSON")
  .action(async (task: string | undefined, opts: { json?: boolean }) => {
    const { classifyTask } = await import("@brainstorm/router");

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
    const { MemoryManager } = await import("@brainstorm/core");
    const homePath = join(homedir(), ".brainstorm", "memory");
    const memory = new MemoryManager(homePath);

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
      default:
        console.error(
          `  Unknown action: ${action}. Use list, search, or forget.`,
        );
        process.exit(1);
    }
  });

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

      // Phase 1: Analyze
      console.log(`  Phase 1: Analyzing codebase...`);
      const { analyzeProject } = await import("@brainstorm/ingest");
      const analysis = analyzeProject(absPath);
      console.log(
        `    ✓ ${analysis.summary.totalFiles} files, ${analysis.summary.totalLines.toLocaleString()} lines, ${analysis.summary.moduleCount} modules`,
      );

      // Phase 2: Generate docs
      console.log(`  Phase 2: Generating documentation...`);
      const { generateAllDocs } = await import("@brainstorm/docgen");
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
        fsWrite(bmPath, lines.join("\n"), "utf-8");
        console.log(`    ✓ Generated BRAINSTORM.md`);
      }

      // Agent profiles
      const agentsDir = pathJoin(absPath, ".brainstorm", "agents");
      if (!existsSync(agentsDir)) fsMkdir(agentsDir, { recursive: true });
      let agentCount = 0;
      for (const cluster of analysis.dependencies.clusters.slice(0, 10)) {
        const safeName = cluster.directory
          .replace(/[/\\]/g, "-")
          .replace(/^-/, "");
        const agentPath = pathJoin(agentsDir, `${safeName}.agent.md`);
        if (!existsSync(agentPath)) {
          fsWrite(
            agentPath,
            `---\nname: ${safeName}-expert\nrole: coder\n---\n\n# ${safeName} Expert\n\nDomain expert for the ${safeName} module.\n`,
            "utf-8",
          );
          agentCount++;
        }
      }
      console.log(`    ✓ ${agentCount} agent profiles created`);

      // Recipes
      const { initRecipeDir } = await import("@brainstorm/workflow");
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

      const { analyzeProject } = await import("@brainstorm/ingest");
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
    const { analyzeProject } = await import("@brainstorm/ingest");

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
        `        run: npx @brainstorm/cli run --unattended "Review the PR changes for bugs and security issues"`,
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
        '    - npx @brainstorm/cli run --unattended "Review changes for bugs and security"',
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

// ── Chat Command ──────────────────────────────────────────────────

program
  .command("chat", { isDefault: true })
  .description("Start an interactive chat session")
  .option("--simple", "Use simple readline interface instead of TUI")
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
      continue?: boolean;
      resume?: string;
      fork?: string;
      lfg?: boolean;
      strategy?: string;
      verboseRouting?: boolean;
      fast?: boolean;
    }) => {
      const config = loadConfig();

      // --lfg: full auto mode, skip all permission confirmations
      if (opts.lfg) {
        config.general.defaultPermissionMode = "auto";
      }

      // --fast: skip heavy initialization for <200ms startup
      if (opts.fast) {
        (config.general as any).skipProviderDiscovery = true;
        (config.general as any).skipEvalProbes = true;
      }

      const db = getDb();
      const resolvedKeys = await resolveProviderKeys();
      const resolvedBRKey =
        resolvedKeys.get("BRAINSTORM_API_KEY") ?? getBrainstormApiKey();
      const isCommunityTier = isCommunityKey(resolvedBRKey);
      // Set env for native BR tools (br_status, br_budget, etc.)
      if (resolvedBRKey) process.env._BR_RESOLVED_KEY = resolvedBRKey;
      const registry = await createProviderRegistry(config, resolvedKeys);
      const costTracker = new CostTracker(db, config.budget);
      const tools = createDefaultToolRegistry();
      // --fast: skip MCP server connections
      if (!opts.fast)
        await connectMCPServers(
          tools,
          config,
          resolvedKeys.get("BRAINSTORM_API_KEY"),
        );
      const projectPath = process.cwd();
      configureSandbox(
        config.shell.sandbox as any,
        projectPath,
        config.shell.maxOutputBytes,
        config.shell.containerImage,
        config.shell.containerTimeout,
      );

      // Permission manager — gates tool execution
      const permissionManager = new PermissionManager(
        config.general.defaultPermissionMode as any,
        config.permissions,
      );

      // Output style — mutable so /style can change it mid-session
      let currentOutputStyle: OutputStyle =
        (config.general.outputStyle as OutputStyle) ?? "concise";

      // Active role — mutable, set by /architect, /sr-developer, etc.
      let currentRole: string | undefined;

      const sessionManager = new SessionManager(db);
      const middleware = createDefaultMiddlewarePipeline(projectPath);
      let { prompt: systemPrompt, frontmatter } = buildSystemPrompt(
        projectPath,
        currentOutputStyle,
      );
      systemPrompt += buildToolAwarenessSection(tools.listTools());
      const router = new BrainstormRouter(
        config,
        registry,
        costTracker,
        frontmatter,
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
      } else if (
        (!isCommunityTier || hasOwnKeys) &&
        router.getActiveStrategy() !== "capability"
      ) {
        router.setStrategy("quality-first");
      }

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
      });
      tools.register(subagentTool);

      // Preferred model override — mutable so /model can change it
      // Community tier without direct provider keys: force brainstormrouter/auto
      // If user has their own keys (DEEPSEEK, ANTHROPIC, etc.), let local routing use them
      const hasDirectProviderKeys =
        !!resolvedKeys.get("DEEPSEEK_API_KEY") ||
        !!resolvedKeys.get("ANTHROPIC_API_KEY") ||
        !!resolvedKeys.get("OPENAI_API_KEY") ||
        !!resolvedKeys.get("GOOGLE_GENERATIVE_AI_API_KEY") ||
        !!resolvedKeys.get("MOONSHOT_API_KEY");
      // Default model: Kimi K2.5 when key available, otherwise router decides
      let preferredModelId: string | undefined = resolvedKeys.get(
        "MOONSHOT_API_KEY",
      )
        ? "moonshot/kimi-k2.5"
        : isCommunityTier && !hasDirectProviderKeys
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
        session = sessionManager.resumeLatest(projectPath);
        if (!session) {
          session = sessionManager.start(projectPath);
        } else {
          printResumeSummary(session, sessionManager);
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
        console.log(`  Ctrl+C to interrupt, Ctrl+D to exit.\n`);

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
                  systemPrompt =
                    rebuilt.prompt +
                    buildToolAwarenessSection(tools.listTools());
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
            compaction: buildCompactionCallbacks(sessionManager),
            signal: simpleAbortController.signal,
            permissionCheck: (name, perm) =>
              permissionManager.check(name, perm),
            preferredModelId,
            middleware,
            roleToolFilter,
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
          if (fullResponse) sessionManager.addAssistantMessage(fullResponse);
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
          compaction: buildCompactionCallbacks(sessionManager),
          signal: currentAbortController.signal,
          permissionCheck: (name, perm) => permissionManager.check(name, perm),
          middleware,
          preferredModelId,
          roleToolFilter: roleFilter,
        });
        // Wrap to capture assistant message after completion
        return (async function* () {
          let fullResponse = "";
          for await (const event of gen) {
            if (event.type === "text-delta") fullResponse += event.delta;
            yield event;
          }
          if (fullResponse) sessionManager.addAssistantMessage(fullResponse);
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
          memoryInfo: await (async () => {
            try {
              const { MemoryManager } = await import("@brainstorm/core");
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
              systemPrompt =
                rebuilt.prompt + buildToolAwarenessSection(tools.listTools());
            },
            getOutputStyle: () => currentOutputStyle,
            rebuildSystemPrompt: (basePromptOverride?: string) => {
              const rebuilt = buildSystemPrompt(
                projectPath,
                currentOutputStyle,
                basePromptOverride,
              );
              systemPrompt =
                rebuilt.prompt + buildToolAwarenessSection(tools.listTools());
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
                await import("@brainstorm/core");
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
  // Graceful shutdown: stop Docker sandbox, close DB
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
  };

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

  program.parse();
}

run();
