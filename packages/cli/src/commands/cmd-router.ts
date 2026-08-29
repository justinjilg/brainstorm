/**
 * `brainstorm router …` — the BrainstormRouter gateway command group.
 * Carved out of cmd-operator so the operator module is focused and its import
 * fan-in is minimal (this group needs only the gateway client).
 */
import { Command } from "commander";
import { createGatewayClient } from "@brainst0rm/gateway";

export function registerRouterCommands(program: Command): void {
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
        const [self, health] = await Promise.all([
          gw.getSelf(),
          gw.getHealth(),
        ]);
        console.log("\n  BrainstormRouter Gateway\n");
        console.log(`  Health:  ${health.status}`);
        console.log(`  Role:    ${self.identity.roles.join(", ")}`);
        console.log(
          `  Caps:    ${self.capabilities.granted.length} permissions`,
        );
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
}
