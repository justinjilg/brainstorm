/**
 * `brainstorm` infra commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { getDb } from "@brainst0rm/db";
import {
  BrainstormVault,
  KeyResolver,
  resolveVaultPassword,
  keychainWrite,
  keychainAvailable,
  VAULT_PASSWORD_ACCOUNT,
} from "@brainst0rm/vault";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { promptPassword } from "../util/prompt-password.js";
import { maskSecret } from "../util/mask-secret.js";
import {
  PROVIDER_KEY_NAMES,
  resolveProviderKeys,
  VAULT_PATH,
} from "./_context.js";

export function registerInfraCommands(program: Command): void {
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
    .command("bootstrap")
    .description(
      "Create the encrypted vault, store its master password in the OS keychain, and import all provider keys — so the vault auto-unlocks with no `op` and no prompt",
    )
    .option(
      "--from-op",
      "Import current key values via the resolver chain (1Password/env) before op is no longer needed",
      true,
    )
    .action(async () => {
      if (!keychainAvailable()) {
        console.error(
          "  OS keychain unavailable (non-macOS or `security` missing). Set BRAINSTORM_VAULT_PASSWORD and run `brainstorm vault init` instead.",
        );
        process.exit(1);
      }

      // 1. Resolve every provider key through the EXISTING chain (op/env) once.
      //    After this, the vault holds them and op is never consulted again.
      const resolved = await resolveProviderKeys();
      const imported: string[] = [];
      const missing: string[] = [];
      for (const name of PROVIDER_KEY_NAMES) {
        (resolved.get(name) ? imported : missing).push(name);
      }

      // 2. Master password: reuse an existing keychain password if present
      //    (idempotent re-bootstrap), else mint a strong random one.
      let password = resolveVaultPassword();
      if (!password) {
        password = randomBytes(32).toString("base64url");
        if (!keychainWrite(VAULT_PASSWORD_ACCOUNT, password)) {
          console.error("  Failed to write master password to keychain.");
          process.exit(1);
        }
        console.log(
          `  Generated vault master password → OS keychain (${VAULT_PASSWORD_ACCOUNT}).`,
        );
      } else {
        console.log(
          "  Reusing existing vault master password from keychain/env.",
        );
      }

      // 3. Init or open the vault, then import the resolved keys.
      const vault = new BrainstormVault(VAULT_PATH);
      if (!vault.exists()) {
        await vault.init(password);
        console.log(`  Vault created at ${VAULT_PATH}`);
      } else {
        vault.open(password);
        console.log("  Opened existing vault.");
      }
      for (const name of imported) {
        const value = resolved.get(name);
        if (value) vault.set(name, value);
      }
      vault.seal();

      console.log(
        `\n  Imported ${imported.length} key(s): ${imported.join(", ") || "(none)"}`,
      );
      if (missing.length > 0) {
        console.log(`  Not found (skipped): ${missing.join(", ")}`);
      }
      console.log(
        "\n  Done. The vault now auto-unlocks from the keychain — `op` is no longer required at runtime.",
      );
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
          console.log(maskSecret(value));
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
    .option(
      "-n, --name <name>",
      "Task name (default: first 30 chars of prompt)",
    )
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
      if (result.tasksFailed > 0)
        console.log(`  Failed:  ${result.tasksFailed}`);
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
}
