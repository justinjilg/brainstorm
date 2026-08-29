/**
 * `brainstorm` backend commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { loadConfig } from "@brainst0rm/config";
import { getDb } from "@brainst0rm/db";
import { createProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import {
  createDefaultToolRegistry,
  createWiredMemoryTool,
  configureSandbox,
} from "@brainst0rm/tools";
import { buildSystemPrompt } from "@brainst0rm/core";
import type { ResolvedKeys } from "@brainst0rm/providers";
import {
  PROVIDER_KEY_NAMES,
  resolveProviderKeys,
  CLI_VERSION,
} from "./_context.js";

export function registerBackendCommands(program: Command): void {
  program
    .command("ipc")
    .description(
      "Start Brainstorm in IPC mode (stdin/stdout NDJSON) for desktop app integration",
    )
    .action(async () => {
      const { startIPCHandler } = await import("../ipc/handler.js");
      const { MemoryManager } = await import("@brainst0rm/core");
      const config = loadConfig();

      // Resolve keys through the full chain (local vault → 1Password →
      // env). Before, ipc mode went straight to process.env — but the
      // desktop app inherits OP_SERVICE_ACCOUNT_TOKEN from the shell and
      // expects 1Password to populate ANTHROPIC_API_KEY / OPENAI_API_KEY
      // / etc. on demand, exactly like `brainstorm models` does. Skipping
      // the resolver made every chat turn fail with "No models available".
      //
      // resolveProviderKeys() has a lazy vault password prompt that only
      // triggers if a local vault exists AND keys aren't available via
      // 1Password/env. In headless IPC mode there's no TTY to answer the
      // prompt, so the prompt handler will reject and fall through; the
      // practical case (1Password configured OR env keys set) works
      // without user interaction. If someone genuinely needs a local
      // vault unlocked, they'll have to run `brainstorm` interactively
      // once to unlock it — out of scope for IPC.
      const resolvedKeys = await resolveProviderKeys();

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
      "Start the Brainstorm control plane HTTP API server (God Mode over HTTP). " +
        "Also starts configured message channels (e.g. Slack) when [channels.slack] " +
        "is enabled in config.",
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

      // Initialize the shell sandbox BEFORE exposing tools. The run/chat paths
      // do this; serve previously did not, so with sandbox="container" the
      // shell tool stayed in default restricted-host mode and channel-initiated
      // commands ran on the host instead of in Docker.
      configureSandbox(
        config.shell.sandbox,
        process.cwd(),
        config.shell.maxOutputBytes,
        config.shell.containerImage,
        config.shell.containerTimeout,
        config.shell.sandboxPool,
      );

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

      // ── Boot: Slack channel intake (optional) ───────────────────
      // Transport/reasoning split: the adapter only moves messages; the
      // IntakeCoordinator drives the same agent loop as every other client,
      // under the channel's configured authority.
      let channelAdapters: Array<{
        name: string;
        start(): Promise<void>;
        stop(): Promise<void>;
      }> = [];
      if (config.channels?.slack?.enabled) {
        try {
          const { SlackAdapter, IntakeCoordinator, ChannelSessionStore } =
            await import("@brainst0rm/channels");
          const slackCfg = config.channels.slack;
          if (slackCfg.mode === "events-api") {
            // The Events-API HTTP transport isn't wired yet (no route, the
            // signing secret is unused). Refuse rather than silently starting
            // Socket Mode, which would run a different transport than configured.
            throw new Error(
              "channels.slack.mode='events-api' is not yet supported — use 'socket'.",
            );
          }
          // Token values are either literals (xoxb-/xapp- prefixed) or env
          // var names. serve is non-interactive by design (env-only key
          // resolution, no vault prompt — see the boot comment above), so
          // vault-stored tokens should be exported to the environment or
          // resolved via 1Password shell plugins.
          const resolveToken = (value: string): string => {
            if (!value) return "";
            if (value.startsWith("xoxb-") || value.startsWith("xapp-")) {
              return value;
            }
            return process.env[value] ?? "";
          };
          const botToken = resolveToken(slackCfg.botToken);
          const appToken = resolveToken(slackCfg.appToken);
          if (!botToken || !appToken) {
            console.log(
              "  Slack channel: enabled but botToken/appToken could not be resolved — skipping.",
            );
          } else {
            const coordinator = new IntakeCoordinator(
              {
                db,
                config,
                registry,
                router,
                costTracker,
                tools,
                projectPath: process.cwd(),
                sessionStore: new ChannelSessionStore(db),
              },
              {
                authority: slackCfg.authority,
                preferredModelId: slackCfg.model,
              },
            );
            channelAdapters = [
              new SlackAdapter({
                botToken,
                appToken,
                authority: slackCfg.authority,
                allowedChannels: slackCfg.allowedChannels,
                allowedUsers: slackCfg.allowedUsers,
                coordinator,
              }),
            ];
            console.log(
              `  Slack channel: enabled (authority: ${slackCfg.authority}, mode: ${slackCfg.mode})`,
            );
          }
        } catch (err: any) {
          console.log(
            `  Slack channel: failed to initialize — ${err?.message ?? err}`,
          );
        }
      }

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
          channels: channelAdapters,
          version: CLI_VERSION,
        },
        {
          port,
          host,
          cors: opts.cors,
          jwtSecret: process.env.SUPABASE_JWT_SECRET,
          jwtIssuer: process.env.BRAINSTORM_JWT_ISSUER,
          jwtAudience: process.env.BRAINSTORM_JWT_AUDIENCE,
          jwksUrl: process.env.BRAINSTORM_JWKS_URL,
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
      console.log(
        `    POST /api/v1/changesets/:id/approve    Approve + execute`,
      );
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

  // ── Dispatch Command (P1.2) ──────────────────────────────────────

  program
    .command("dispatch <tool>")
    .description(
      "Dispatch a tool to a Brainstorm endpoint via the relay (governed channel)",
    )
    .requiredOption(
      "--endpoint <id>",
      "target endpoint_id (UUID, registered via /v1/endpoint/enroll)",
    )
    .option("--params <json>", "tool params as JSON object", "{}")
    .option(
      "--relay-url <url>",
      "relay base URL (default ws://127.0.0.1:8443; env BRAINSTORM_RELAY_URL)",
    )
    .option(
      "--api-key <key>",
      "operator API key (default env BRAINSTORM_OPERATOR_API_KEY)",
    )
    .option(
      "--operator-id <id>",
      "operator id (default env BRAINSTORM_OPERATOR_ID or 'operator@local')",
    )
    .option(
      "--tenant-id <id>",
      "tenant id (default env BRAINSTORM_TENANT_ID or 'tenant-local')",
    )
    .option(
      "--correlation-id <id>",
      "cross-product correlation id (default: auto-generated)",
    )
    .option("--yes", "auto-confirm ChangeSet preview without prompt")
    .option("--no-stream-progress", "disable streaming ProgressEvent updates")
    .option(
      "--deadline-ms <ms>",
      "operator-side dispatch deadline in milliseconds",
      "30000",
    )
    .action(
      async (
        tool: string,
        opts: {
          endpoint: string;
          params?: string;
          relayUrl?: string;
          apiKey?: string;
          operatorId?: string;
          tenantId?: string;
          correlationId?: string;
          yes?: boolean;
          streamProgress?: boolean;
          deadlineMs?: string;
        },
      ) => {
        try {
          const { runDispatch } = await import("../commands/dispatch.js");
          const exitCode = await runDispatch({
            tool,
            endpoint: opts.endpoint,
            paramsJson: opts.params,
            relayUrl: opts.relayUrl,
            apiKey: opts.apiKey,
            operatorId: opts.operatorId,
            tenantId: opts.tenantId,
            correlationId: opts.correlationId,
            yes: opts.yes,
            noStreamProgress: opts.streamProgress === false,
            deadlineMs: opts.deadlineMs
              ? parseInt(opts.deadlineMs, 10)
              : 30_000,
          });
          process.exit(exitCode);
        } catch (e) {
          console.error(`[dispatch] ${(e as Error).message}`);
          process.exit(5);
        }
      },
    );

  // ── Chat Command ──────────────────────────────────────────────────
}
