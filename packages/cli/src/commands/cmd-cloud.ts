/**
 * `brainstorm` cloud commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { getDb, closeDb } from "@brainst0rm/db";
import { BrainstormRouter } from "@brainst0rm/router";
import { SessionManager } from "@brainst0rm/core";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export function registerCloudCommands(program: Command): void {
  const auditCmd = program
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

  auditCmd
    .command("report")
    .description(
      "Render God Mode ChangeSet audit entries to a self-contained HTML evidence report",
    )
    .option("--changeset <id>", "Filter to a single changeset id")
    .option("-o, --output <dir>", "Output directory")
    .action(async (opts: { changeset?: string; output?: string }) => {
      const { ChangeSetLogRepository } = await import("@brainst0rm/db");
      const { renderChangeSetReport, createEvidenceBundle } =
        await import("@brainst0rm/godmode");
      const { ensureWorkspace, getWorkspaceDir } =
        await import("@brainst0rm/workflow");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");

      const db = getDb();
      const repo = new ChangeSetLogRepository(db);
      // Evidence tool: never silently truncate. Filtered lookups scan the
      // full table (a missed old changeset would be a false negative);
      // unfiltered reports cap at 1000 newest but say so.
      const total = repo.count();
      const REPORT_CAP = 1000;
      const rows = opts.changeset
        ? repo
            .recent(Math.max(total, 1))
            .filter((r) => r.changesetId === opts.changeset)
        : repo.recent(REPORT_CAP);

      if (rows.length === 0) {
        console.log("  No ChangeSet audit entries found.");
        return;
      }
      if (!opts.changeset && total > REPORT_CAP) {
        console.log(
          `  Note: report covers the ${REPORT_CAP} most recent of ${total} entries. Use --changeset <id> for older ones.`,
        );
      }

      const entries = rows.map((r) => ({
        changesetId: r.changesetId,
        connector: r.connector,
        action: r.action,
        description: r.description,
        riskScore: r.riskScore,
        status: r.status,
        changesJson: r.changesJson ?? "",
        simulationJson: r.simulationJson ?? "",
        rollbackJson: r.rollbackJson,
        createdAt: r.createdAt,
        executedAt: r.executedAt,
      }));

      const reportHtml = renderChangeSetReport(entries);

      const runId = `audit-report-${Date.now()}`;
      let outDir: string;
      if (opts.output) {
        outDir = opts.output;
        mkdirSync(outDir, { recursive: true });
      } else {
        ensureWorkspace(runId);
        outDir = join(getWorkspaceDir(runId), "outputs");
        mkdirSync(outDir, { recursive: true });
      }

      const reportPath = join(outDir, "report.html");
      writeFileSync(reportPath, reportHtml, "utf8");
      console.log(`  Wrote ${reportPath}`);

      const secret = process.env.BRAINSTORM_PLATFORM_SECRET;
      if (secret) {
        const bundle = createEvidenceBundle(entries, reportHtml, secret);
        const evidencePath = join(outDir, "evidence.json");
        writeFileSync(evidencePath, JSON.stringify(bundle, null, 2), "utf8");
        console.log(`  Wrote ${evidencePath}`);
      } else {
        console.log(
          "  WARNING: report is UNSIGNED (BRAINSTORM_PLATFORM_SECRET not set).",
        );
        console.log(
          "  Set BRAINSTORM_PLATFORM_SECRET to produce a signed evidence.json bundle.",
        );
      }
    });

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
    .action(
      async (action: string, task?: string, opts?: { budget: string }) => {
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
            console.error(
              `  Unknown action: ${action}. Use: run, status, list`,
            );
        }
        console.log();
      },
    );

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
        if (!existsSync(workflowDir))
          mkdirSync(workflowDir, { recursive: true });

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
}
