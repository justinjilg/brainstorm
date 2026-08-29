/**
 * `brainstorm` platform commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { atomicWriteFile } from "@brainst0rm/shared";
import { BrainstormRouter } from "@brainst0rm/router";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fetchEcosystemStatuses, renderEcosystemTable } from "./status.js";

export function registerPlatformCommands(program: Command): void {
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
        const icon =
          r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "○";
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
      const { existsSync, readFileSync } = await import("node:fs");
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
            // atomicWriteFile — ~/.claude/mcp.json is shared across Claude Code
            // tools and typically holds other MCP server configs. A crash mid-
            // writeFileSync would truncate the file and break those unrelated
            // tools. pid+uuid temp + rename keeps the write all-or-nothing.
            atomicWriteFile(mcpPath, JSON.stringify(existing, null, 2));
            console.log(
              `\n  ✓ Added brainstorm MCP server to ~/.claude/mcp.json`,
            );
          } else {
            console.log(
              `\n  ✓ brainstorm MCP server already in ~/.claude/mcp.json`,
            );
          }
        } catch {
          console.log(
            `\n  ⚠ Could not update ~/.claude/mcp.json (parse error)`,
          );
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
    .option("--json", "Output as JSON (skips auth / MCP narrative)")
    .option("--product <id>", "Limit to one product id (msp|br|gtm|vm|shield)")
    .action(async (opts: { json?: boolean; product?: string }) => {
      // --json or --product paths use the new structured fetcher
      // (P0/Wk1 #59 of radiant-petting-kitten rev 2 — adds Edge Protocol probe
      // and machine-readable output to the existing ecosystem command).
      if (opts.json || opts.product) {
        const statuses = await fetchEcosystemStatuses(opts.product);
        if (!statuses) {
          console.error(
            `  Unknown --product ${opts.product}. Known: msp, br, gtm, vm, shield`,
          );
          process.exitCode = 2;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(statuses, null, 2));
        } else {
          console.log(renderEcosystemTable(statuses));
        }
        return;
      }

      // Default path: legacy human-readable rendering with auth + MCP narrative
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
}
