/**
 * `brainstorm backup ...` — operate the brainstorm-backup product from the CLI.
 *
 * Plan reference: v0.6 P0 M02 — closes v0.5 M23 (CLI subcommand was scoped
 * but slipped at v0.5 ship). The backup service shipped its 6 god-mode tools
 * in v0.5 P2 / brainstorm-backup PR #2:
 *   - backup.create_schedule
 *   - backup.list_schedules
 *   - backup.run_now
 *   - backup.run_restore_drill
 *   - backup.list_drills
 *   - backup.purge
 *
 * All flow through `POST {backup_url}/api/v1/god-mode/execute` per the
 * platform contract v1. The CLI is a thin operator surface; the heavy
 * lifting (scheduler, replication, drill engine) lives in the service.
 *
 * Auth: Bearer JWT from `~/.brainstorm/session` (same as `brainstorm a2a`).
 * Backup URL default: `https://backup.brainstorm.co`. Override with --base
 * or env `BRAINSTORM_BACKUP_URL`.
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BACKUP_URL = "https://backup.brainstorm.co";
const SESSION_PATH = join(homedir(), ".brainstorm", "session");

interface SessionFile {
  access_token?: string;
  /** `did:bvm:<tenant>:<user>` per v0.3 login.ts comment. */
  did?: string;
}

interface SessionContext {
  token: string | undefined;
  tenantId: string | undefined;
}

function loadSession(explicitToken: string | undefined): SessionContext {
  if (explicitToken) {
    return { token: explicitToken, tenantId: undefined };
  }
  const envToken = process.env.BRAINSTORM_API_KEY;
  if (envToken) {
    return { token: envToken, tenantId: undefined };
  }
  try {
    const raw = readFileSync(SESSION_PATH, "utf8");
    const parsed = JSON.parse(raw) as SessionFile;
    return {
      token: parsed.access_token,
      tenantId: parseTenantFromDid(parsed.did),
    };
  } catch {
    return { token: undefined, tenantId: undefined };
  }
}

function parseTenantFromDid(did: string | undefined): string | undefined {
  if (!did) return undefined;
  // `did:bvm:<tenant>:<user>` — tenant is the third segment.
  const parts = did.split(":");
  return parts.length >= 4 ? parts[2] : undefined;
}

/**
 * Codex r1 P1: token leaks over http:// if --base or env hands us a
 * plaintext URL. Reject anything that isn't https://, except an
 * explicit localhost/loopback dev escape hatch.
 */
function assertSecureBase(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.error(`Invalid backup base URL: ${url}`);
    process.exit(3);
  }
  if (parsed.protocol === "https:") return;
  const host = parsed.hostname;
  const isLocalhost =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol === "http:" && isLocalhost) return;
  console.error(
    `Refusing to send bearer token over ${parsed.protocol}//${host}. ` +
      `Use https:// or a localhost/loopback base URL for dev.`,
  );
  process.exit(3);
}

function resolveBackupUrl(explicitBase: string | undefined): string {
  if (explicitBase) return explicitBase.replace(/\/$/, "");
  const envUrl = process.env.BRAINSTORM_BACKUP_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");
  return DEFAULT_BACKUP_URL;
}

interface InvokeOptions {
  base?: string;
  token?: string;
  json?: boolean;
  /** Override the X-Tenant-ID header (otherwise parsed from session DID). */
  tenant?: string;
}

interface GodModeResponse {
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
  trace_id?: string;
}

/**
 * Parses a retention duration string like "30d" or "90d" into a day count.
 * Returns undefined when the input is empty/undefined; throws on malformed.
 */
export function parseRetentionDays(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  const m = /^([0-9]+)d$/.exec(value.trim());
  if (!m) {
    throw new Error(
      `Invalid retention '${value}'. Expected '<N>d' (e.g. '30d').`,
    );
  }
  return Number.parseInt(m[1], 10);
}

async function invokeBackupTool(
  toolName: string,
  input: Record<string, unknown>,
  opts: InvokeOptions,
): Promise<void> {
  const session = loadSession(opts.token);
  if (!session.token) {
    console.error(
      "No auth token. Run `brainstorm login` first or pass --token.",
    );
    process.exit(2);
  }
  const tenantId = opts.tenant ?? session.tenantId;
  if (!tenantId) {
    console.error(
      "No tenant context. Pass --tenant <id>, or run `brainstorm login` to " +
        "bind a session whose DID encodes the tenant.",
    );
    process.exit(2);
  }
  const baseUrl = resolveBackupUrl(opts.base);
  assertSecureBase(baseUrl);
  const url = `${baseUrl}/api/v1/god-mode/execute`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        // Codex r1 P1: backup service reads tenant from this header, not
        // from the bearer token payload. Missing it returns 400 missing_tenant.
        "X-Tenant-ID": tenantId,
      },
      // Codex r1 P1: backup service expects `input`, not `params`.
      body: JSON.stringify({ tool: toolName, input }),
    });
  } catch (err) {
    console.error(
      `Network error reaching ${url}: ${(err as Error).message ?? err}`,
    );
    process.exit(4);
  }

  let body: GodModeResponse;
  try {
    body = (await response.json()) as GodModeResponse;
  } catch {
    console.error(`Non-JSON response (HTTP ${response.status}) from ${url}`);
    process.exit(5);
  }

  if (!response.ok || body.error) {
    const code = body.error?.code ?? `HTTP_${response.status}`;
    const msg =
      body.error?.message ?? `${response.status} ${response.statusText}`;
    if (opts.json) {
      process.stdout.write(JSON.stringify(body));
      process.stdout.write("\n");
    } else {
      console.error(`backup.${toolName} failed: [${code}] ${msg}`);
    }
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(body.data, null, 2));
  process.stdout.write("\n");
}

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command("backup")
    .description(
      "Operate the brainstorm-backup product (schedules, drills, runs)",
    );

  // Shared option set — every subcommand needs base + token + json + tenant.
  // The service reads tenant from the X-Tenant-ID header (not the JWT body),
  // so --tenant is universal: pass explicitly, or auto-resolve from the
  // session DID at request time.
  const sharedOptions = (cmd: Command): Command =>
    cmd
      .option(
        "--base <url>",
        `Backup service base URL (default ${DEFAULT_BACKUP_URL})`,
      )
      .option(
        "--token <jwt>",
        "Bearer JWT (default: BRAINSTORM_API_KEY env or ~/.brainstorm/session)",
      )
      .option("--tenant <id>", "Tenant ID (default: parsed from session DID)")
      .option(
        "--json",
        "Emit raw JSON response (default: pretty-printed data)",
      );

  sharedOptions(
    backup
      .command("list-schedules")
      .description("List backup schedules for the current tenant"),
  ).action(async (opts: InvokeOptions) => {
    await invokeBackupTool("backup.list_schedules", {}, opts);
  });

  sharedOptions(
    backup
      .command("create-schedule")
      .description("Create a new backup schedule")
      .requiredOption("--name <name>", "Schedule name (unique per tenant)")
      .requiredOption(
        "--cadence <cron>",
        "Cron expression (e.g. '0 2 * * *' for nightly at 02:00)",
      )
      .requiredOption(
        "--target <provider>",
        "Replication target: 's3' or 'linstor'",
      )
      .option(
        "--retention <duration>",
        "Retention period (e.g. '30d', '90d')",
        "30d",
      )
      .option("--source <id>", "Source resource ID to back up"),
  ).action(
    async (
      opts: InvokeOptions & {
        name: string;
        cadence: string;
        target: string;
        retention: string;
        source?: string;
      },
    ) => {
      // Codex r1 P1: service field names are cron + retention_days + source,
      // not the friendlier CLI flag names. Translate at the boundary.
      let retentionDays: number;
      try {
        retentionDays = parseRetentionDays(opts.retention) ?? 30;
      } catch (e) {
        console.error((e as Error).message);
        process.exit(2);
      }
      const input: Record<string, unknown> = {
        name: opts.name,
        cron: opts.cadence,
        target: opts.target,
        retention_days: retentionDays,
      };
      if (opts.source) input.source = opts.source;
      await invokeBackupTool("backup.create_schedule", input, opts);
    },
  );

  sharedOptions(
    backup
      .command("run-now")
      .description("Trigger an immediate backup run for a schedule")
      .requiredOption("--schedule-id <id>", "Schedule ID"),
  ).action(async (opts: InvokeOptions & { scheduleId: string }) => {
    await invokeBackupTool(
      "backup.run_now",
      { schedule_id: opts.scheduleId },
      opts,
    );
  });

  sharedOptions(
    backup
      .command("list-drills")
      .description("List restore drills for the current tenant")
      .option("--schedule-id <id>", "Filter to one schedule"),
  ).action(async (opts: InvokeOptions & { scheduleId?: string }) => {
    const input: Record<string, unknown> = {};
    if (opts.scheduleId) input.schedule_id = opts.scheduleId;
    await invokeBackupTool("backup.list_drills", input, opts);
  });

  sharedOptions(
    backup
      .command("run-restore-drill")
      .description(
        "Run a restore drill — restore latest backup to scratch + checksum",
      )
      .requiredOption("--schedule-id <id>", "Schedule ID"),
  ).action(async (opts: InvokeOptions & { scheduleId: string }) => {
    await invokeBackupTool(
      "backup.run_restore_drill",
      { schedule_id: opts.scheduleId },
      opts,
    );
  });

  sharedOptions(
    backup
      .command("purge")
      .description(
        "Delete a schedule + cascade its runs + drills (destructive)",
      )
      .requiredOption("--schedule-id <id>", "Schedule ID")
      .requiredOption(
        "--confirm",
        "Must pass --confirm to acknowledge destruction",
      ),
  ).action(
    async (opts: InvokeOptions & { scheduleId: string; confirm: boolean }) => {
      if (!opts.confirm) {
        console.error("Refusing to purge without --confirm.");
        process.exit(2);
      }
      await invokeBackupTool(
        "backup.purge",
        { schedule_id: opts.scheduleId, confirm: true },
        opts,
      );
    },
  );
}
