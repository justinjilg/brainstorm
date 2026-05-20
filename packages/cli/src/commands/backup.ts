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
}

function loadToken(explicitToken: string | undefined): string | undefined {
  if (explicitToken) return explicitToken;
  const envToken = process.env.BRAINSTORM_API_KEY;
  if (envToken) return envToken;
  try {
    const raw = readFileSync(SESSION_PATH, "utf8");
    const parsed = JSON.parse(raw) as SessionFile;
    return parsed.access_token;
  } catch {
    return undefined;
  }
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
}

interface GodModeResponse {
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
  trace_id?: string;
}

async function invokeBackupTool(
  toolName: string,
  params: Record<string, unknown>,
  opts: InvokeOptions,
): Promise<void> {
  const token = loadToken(opts.token);
  if (!token) {
    console.error(
      "No auth token. Run `brainstorm login` first or pass --token.",
    );
    process.exit(2);
  }
  const url = `${resolveBackupUrl(opts.base)}/api/v1/god-mode/execute`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tool: toolName, params }),
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

  if (opts.json) {
    process.stdout.write(JSON.stringify(body.data, null, 2));
    process.stdout.write("\n");
  } else {
    process.stdout.write(JSON.stringify(body.data, null, 2));
    process.stdout.write("\n");
  }
}

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command("backup")
    .description(
      "Operate the brainstorm-backup product (schedules, drills, runs)",
    );

  // Shared option set — every subcommand needs base + token + json.
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
      .option(
        "--json",
        "Emit raw JSON response (default: pretty-printed data)",
      );

  sharedOptions(
    backup
      .command("list-schedules")
      .description("List backup schedules for the current tenant")
      .option("--tenant <id>", "Tenant ID (default: derived from JWT)"),
  ).action(async (opts: InvokeOptions & { tenant?: string }) => {
    const params: Record<string, unknown> = {};
    if (opts.tenant) params.tenant_id = opts.tenant;
    await invokeBackupTool("backup.list_schedules", params, opts);
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
      const params: Record<string, unknown> = {
        name: opts.name,
        cadence: opts.cadence,
        target: opts.target,
        retention: opts.retention,
      };
      if (opts.source) params.source_id = opts.source;
      await invokeBackupTool("backup.create_schedule", params, opts);
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
    const params: Record<string, unknown> = {};
    if (opts.scheduleId) params.schedule_id = opts.scheduleId;
    await invokeBackupTool("backup.list_drills", params, opts);
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
