/**
 * Shared CLI context: the helpers, constants, and small utilities that many
 * `brainstorm` subcommands need — extracted verbatim from the former
 * bin/brainstorm.ts god-file so command modules under commands/ can import them.
 * (Phase 1 of the UX reimagining: split the entry file into commands/*.)
 */
import { loadConfig } from "@brainst0rm/config";
import { createProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter } from "@brainst0rm/router";
import { createDefaultToolRegistry } from "@brainst0rm/tools";
import { SessionManager, type CompactionCallbacks } from "@brainst0rm/core";
import { createGatewayClient } from "@brainst0rm/gateway";
import { MCPClientManager } from "@brainst0rm/mcp";
import {
  BrainstormVault,
  KeyResolver,
  resolveVaultPassword,
} from "@brainst0rm/vault";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedKeys } from "@brainst0rm/providers";
import {
  type DoctorCheckResult,
  type DoctorSection,
  annotateDoctorRunbooks,
} from "../logic/doctor-runbook.js";
import { readFileSync as readFileSyncVersion } from "node:fs";
import { dirname as dirnameVersion } from "node:path";
import { fileURLToPath as fileURLToPathVersion } from "node:url";
import { promptPassword } from "../util/prompt-password.js";

export const PROVIDER_KEY_NAMES = [
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
export interface ResolvedKeysWithResolver extends ResolvedKeys {
  /** Resolve configuration-defined provider keys that are not in the eager list. */
  resolve(name: string): Promise<string | null>;
  /** Async resolver for $VAULT_* substitution — can look up any key, not just provider keys. */
  resolver: KeyResolver;
}

export async function resolveProviderKeys(): Promise<ResolvedKeysWithResolver> {
  const vault = new BrainstormVault(VAULT_PATH);
  const resolver = new KeyResolver(vault.exists() ? vault : null, async () => {
    // Non-interactive unlock first: env override → macOS Keychain. This is
    // what lets the desktop app / KAIROS daemon open the vault headlessly with
    // no `op` and no TTY. Only fall back to an interactive prompt when a real
    // terminal is attached; otherwise throw so the resolver falls through to
    // its other backends instead of hanging on a prompt nobody can answer.
    const stored = resolveVaultPassword();
    if (stored) return stored;
    if (process.stdin.isTTY) return promptPassword("  Vault password: ");
    throw new Error(
      "vault locked: no BRAINSTORM_VAULT_PASSWORD / keychain password and no TTY",
    );
  });

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
    resolve: (name: string) => resolver.get(name),
    resolver,
  };
}

export function buildCompactionCallbacks(
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
export async function startSyncWorkerIfConfigured(
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
export async function connectMCPServers(
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

// ── LLM memory extraction (fire-and-forget teardown hook) ──────────
//
// Runs an async cheap-model pass over the session transcript to extract
// durable memories, augmenting the regex-based extraction middleware.
// Gated internally by runExtractionCycle (min turns + lock file), so
// it's cheap to call unconditionally at every teardown point.
export interface ExtractionTeardownParams {
  projectPath: string;
  sessionManager: { getHistory(): Array<{ role: string; content: string }> };
  config: unknown;
  registry: unknown;
  router: unknown;
  costTracker: unknown;
  tools: unknown;
  /** Hard-cap in ms when the caller must await before process exit. */
  hardTimeoutMs?: number;
}

export async function runMemoryExtractionTeardown(
  params: ExtractionTeardownParams,
): Promise<void> {
  const {
    projectPath,
    sessionManager,
    config,
    registry,
    router,
    costTracker,
    tools,
    hardTimeoutMs,
  } = params;

  // Abort controller so the hard-timeout cap actually cancels the extraction
  // subagent's in-flight provider request, rather than merely resolving the
  // wrapper promise while billable network work continues in the background.
  const abort = new AbortController();

  const task = (async () => {
    const { MemoryManager, runExtractionCycle } =
      await import("@brainst0rm/core");
    const memory = new MemoryManager(projectPath);
    try {
      const history = sessionManager.getHistory();

      // Most-recent-first truncation from the head, capped at ~20k chars.
      const lines = history
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `${m.role}: ${m.content}`);
      let transcript = lines.join("\n\n");
      if (transcript.length > 20_000) {
        transcript = transcript.slice(transcript.length - 20_000);
      }
      const sessionTurns = history.filter((m) => m.role === "assistant").length;

      await runExtractionCycle({
        memoryDir: memory.getMemoryDir(),
        memoryManager: memory,
        transcript,
        sessionTurns,
        subagentOptions: {
          config,
          registry,
          router,
          costTracker,
          tools,
          projectPath,
          permissionCheck: () => "allow",
          parentSignal: abort.signal,
        } as any,
      });
    } finally {
      // Flush the debounced MEMORY.md rebuild before exit — otherwise a
      // freshly-written extraction file leaves the index stale and the next
      // pass misses it during dedup.
      try {
        (memory as any).dispose?.();
      } catch {
        /* best-effort */
      }
    }
  })().catch((err) => {
    if (process.env.DEBUG) {
      process.stderr.write(
        `[memory-extract] ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  });

  if (hardTimeoutMs) {
    // Teardown path exits the process immediately (e.g. the one-shot
    // `run` command, or interactive chat quitting) — await with a hard
    // cap so extraction gets a chance to finish without ever delaying
    // process exit. The timer is unref'd and cleared so it never holds
    // the event loop open by itself once the task settles. On timeout we
    // abort the extraction so it stops consuming tokens past the cap.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        abort.abort();
        resolve();
      }, hardTimeoutMs);
      timer.unref();
      task.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export const execFile = promisify(execFileCallback);
export function formatDoctorStatus(
  status: DoctorCheckResult["status"],
): string {
  return status === "pass" ? "✓" : status === "fail" ? "✗" : "○";
}

export function parseEnvExampleKeys(content: string): string[] {
  const keys = new Set<string>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*?)\s*=/);
    if (match?.[1]) keys.add(match[1]);
  }

  return [...keys];
}

export async function runBuildDoctorCheck(cwd: string): Promise<DoctorSection> {
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

export function runEnvDoctorCheck(cwd: string): DoctorSection {
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

export async function runModelDoctorCheck(): Promise<DoctorSection> {
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

export function printDoctorSection(section: DoctorSection): void {
  const annotated = annotateDoctorRunbooks(section);
  console.log(`\n  ${annotated.title}:`);
  for (const result of annotated.results) {
    console.log(
      `    ${formatDoctorStatus(result.status)} ${result.name.padEnd(20)} ${result.detail}`,
    );
    // Path-to-90 P8a: surface the runbook so the operator follows the
    // chain. Indented under the failed line so it's visually attached
    // to the failure it documents.
    if (result.runbook) {
      console.log(`        → see ${result.runbook}`);
    }
  }
}

// Read version from package.json at runtime (stays in sync with bump-version.mjs)
export const __pkg_dir = join(
  dirnameVersion(fileURLToPathVersion(import.meta.url)),
  "..",
);
export let CLI_VERSION = "0.12.1";
try {
  CLI_VERSION = JSON.parse(
    readFileSyncVersion(join(__pkg_dir, "package.json"), "utf-8"),
  ).version;
} catch {
  /* fallback */
}

export const VAULT_PATH = join(homedir(), ".brainstorm", "vault.enc");
export function printResumeSummary(
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
