/**
 * `brainstorm` operator commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { loadConfig } from "@brainst0rm/config";
import { getDb } from "@brainst0rm/db";
import { createProviderRegistry } from "@brainst0rm/providers";
import { CostTracker } from "@brainst0rm/router";
import { createDefaultToolRegistry } from "@brainst0rm/tools";
import { resolveProviderKeys, CLI_VERSION } from "./_context.js";

export function registerOperatorCommands(program: Command): void {
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
      // Sandbox + warm pool
      const pool = config.shell.sandboxPool;
      console.log(
        `  Sandbox:      ${config.shell.sandbox}${
          config.shell.sandbox === "container" && pool.enabled
            ? ` (warm pool: ${pool.maxIdlePerKey}/key, ${pool.maxIdleTotal} total, idle ${Math.round(pool.idleTimeoutMs / 1000)}s)`
            : ""
        }`,
      );
      // Channel intake
      const slack = config.channels?.slack;
      console.log(
        `  Slack channel: ${
          slack?.enabled
            ? `enabled (authority: ${slack.authority}, mode: ${slack.mode})`
            : "disabled"
        }`,
      );
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
        openai:
          !!process.env.OPENAI_API_KEY || !!process.env.BRAINSTORM_API_KEY,
        google:
          !!process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
          !!process.env.BRAINSTORM_API_KEY,
        msp:
          !!process.env.BRAINSTORM_MSP_API_KEY || !!process.env._GM_AGENT_KEY,
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
}
