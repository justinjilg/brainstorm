/**
 * `brainstorm` knowledge commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { loadConfig } from "@brainst0rm/config";
import { getDb, CostRepository } from "@brainst0rm/db";
import { createProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { createDefaultToolRegistry } from "@brainst0rm/tools";
import {
  buildSystemPrompt,
  SessionManager,
  spawnSubagent,
} from "@brainst0rm/core";
import { createGatewayClient } from "@brainst0rm/gateway";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveProviderKeys } from "./_context.js";

export function registerKnowledgeCommands(program: Command): void {
  const codebaseCmd = program
    .command("codebase")
    .description(
      "Codebase audit tools — fleet-agent documentation and analysis",
    );

  codebaseCmd
    .command("audit")
    .description(
      "Run a fleet of agents to audit this codebase and write findings to shared memory",
    )
    .option("--workers <n>", "Concurrent workers (default 3)", "3")
    .option("--budget <usd>", "Total budget cap in USD", "5")
    .option(
      "--categories <list>",
      "Comma-separated categories to emphasize (default: security,correctness,reliability,performance,maintainability,tech-debt,testing)",
    )
    .option(
      "--min-severity <level>",
      "Minimum severity to report: critical|high|medium|low|info",
      "low",
    )
    .option(
      "--scopes <list>",
      "Comma-separated scope names (default: auto-discover)",
    )
    .option(
      "--model <id>",
      "Force a specific model for all workers (bypass router). Example: google/gemini-2.5-flash",
    )
    .action(
      async (opts: {
        workers: string;
        budget: string;
        categories?: string;
        minSeverity: string;
        scopes?: string;
        model?: string;
      }) => {
        const {
          runCodebaseAudit,
          discoverScopes,
          MemoryManager: AuditMemoryManager,
        } = await import("@brainst0rm/core");

        const projectPath = process.cwd();
        const concurrency = parseInt(opts.workers, 10);
        const budgetLimit = parseFloat(opts.budget);
        const minSeverity = opts.minSeverity as
          | "critical"
          | "high"
          | "medium"
          | "low"
          | "info";

        console.log(`\n  Codebase Audit\n`);
        console.log(`  Project: ${projectPath}`);
        console.log(`  Workers: ${concurrency} concurrent`);
        console.log(`  Budget:  $${budgetLimit.toFixed(2)}`);
        console.log(`  Min severity: ${minSeverity}`);

        // Discover scopes so we can show the plan before spending money
        const allScopes = discoverScopes(projectPath);
        const filteredScopes =
          opts.scopes !== undefined
            ? allScopes.filter((s) =>
                opts
                  .scopes!.split(",")
                  .map((x) => x.trim())
                  .includes(s.name),
              )
            : allScopes;

        if (filteredScopes.length === 0) {
          console.error("\n  No scopes discovered. Aborting.\n");
          process.exit(1);
        }

        console.log(`  Scopes:  ${filteredScopes.length}`);
        for (const s of filteredScopes.slice(0, 10)) {
          console.log(`    - ${s.name}`);
        }
        if (filteredScopes.length > 10) {
          console.log(`    ... and ${filteredScopes.length - 10} more`);
        }
        console.log();

        // Runtime setup — same pattern as orchestrate parallel
        const config = loadConfig();
        config.general.defaultPermissionMode = "auto";
        const db = getDb();
        const resolvedKeys = await resolveProviderKeys();
        const registry = await createProviderRegistry(config, resolvedKeys);
        const costTracker = new CostTracker(db, config.budget);
        const tools = createDefaultToolRegistry();
        const { frontmatter } = buildSystemPrompt(projectPath);
        const router = new BrainstormRouter(
          config,
          registry,
          costTracker,
          frontmatter,
        );
        router.setStrategy("capability");

        const auditGateway = createGatewayClient();
        const memory = new AuditMemoryManager(projectPath, auditGateway);

        const sharedSubagentOptions: any = {
          config,
          registry,
          router,
          costTracker,
          tools,
          projectPath,
          permissionCheck: () => "allow",
          // If --model was passed, force every worker to use that exact model.
          // Useful to bypass routing fallbacks that can hit BR SaaS guardrails
          // on code-review content. Example: --model google/gemini-2.5-flash
          // routes directly to the Google provider if GOOGLE_GENERATIVE_AI_API_KEY
          // is configured, skipping brainstormrouter/auto entirely.
          ...(opts.model ? { preferredModelId: opts.model } : {}),
        };

        if (opts.model) {
          console.log(`  Model:   ${opts.model} (forced)`);
        }

        // Parse optional categories list
        const categories = opts.categories
          ? (opts.categories.split(",").map((c) => c.trim()) as any)
          : undefined;

        const gen = runCodebaseAudit({
          projectPath,
          memory,
          subagentOptions: sharedSubagentOptions,
          scopes: filteredScopes,
          categories,
          concurrency,
          budgetLimit,
          minSeverity,
        });

        let result: any = null;
        while (true) {
          const next = await gen.next();
          if (next.done) {
            result = next.value;
            break;
          }
          const ev = next.value;
          switch (ev.type) {
            case "audit-started":
              console.log(
                `  [Fleet] starting — $${ev.perScopeBudget.toFixed(3)}/scope\n`,
              );
              break;
            case "worker-started":
              console.log(`  [${ev.workerId}] ▶ ${ev.scope.name}`);
              break;
            case "worker-completed":
              console.log(
                `  [${ev.workerId}] ✓ ${ev.scope.name} — ${ev.findingsCount} findings ($${ev.cost.toFixed(4)})`,
              );
              break;
            case "worker-failed":
              console.log(
                `  [${ev.workerId}] ✗ ${ev.scope.name} — ${ev.error.slice(0, 80)}`,
              );
              break;
            case "finding-recorded": {
              const sev = ev.finding.severity.toUpperCase().padEnd(8);
              const loc = ev.finding.lineStart
                ? `${ev.finding.file}:${ev.finding.lineStart}`
                : ev.finding.file;
              console.log(
                `    ${sev} ${loc} — ${ev.finding.title.slice(0, 80)}`,
              );
              break;
            }
            case "audit-completed":
              console.log(
                `\n  [Fleet] ${ev.totalFindings} findings in ${Math.round(ev.durationMs / 1000)}s ($${ev.totalCost.toFixed(4)})`,
              );
              break;
          }
        }

        console.log(`  Run: brainstorm findings summary to aggregate\n`);
        process.exit(result?.totalFindings > 0 ? 0 : 1);
      },
    );

  // ── Findings Command ──────────────────────────────────────────────
  //
  // Query the findings store produced by `brainstorm codebase audit`.
  // Findings live as memory entries with a [FINDING] envelope, so they
  // sync across machines via the same BR shared memory path.

  program
    .command("findings")
    .description("Query, summarize, and act on codebase audit findings")
    .argument(
      "[action]",
      "Action: list | summary | show <id> | delete <id> | fix <id>",
      "summary",
    )
    .argument("[id]", "Finding ID (required for show, delete, fix)")
    .option(
      "--severity <level>",
      "Filter by severity (critical|high|medium|low|info)",
    )
    .option(
      "--category <name>",
      "Filter by category (e.g., security, performance)",
    )
    .option("--file <substring>", "Filter by file path substring")
    .option(
      "--query <text>",
      "Free-text search across title + description + file",
    )
    .option("--limit <n>", "Max results to show (list only)", "50")
    .option(
      "--model <id>",
      "Force a specific model for fix subagent (e.g., google/gemini-2.5-flash)",
    )
    .option("--budget <usd>", "Budget cap for fix subagent in USD", "1")
    .action(
      async (
        action: string,
        id: string | undefined,
        opts: {
          severity?: string;
          category?: string;
          file?: string;
          query?: string;
          limit: string;
          model?: string;
          budget: string;
        },
      ) => {
        const { MemoryManager: FindingsMemoryManager, FindingsStore } =
          await import("@brainst0rm/core");

        const memory = new FindingsMemoryManager(process.cwd());
        const store = new FindingsStore(memory);

        const filter = {
          ...(opts.severity ? { severity: opts.severity as any } : {}),
          ...(opts.category ? { category: opts.category as any } : {}),
          ...(opts.file ? { file: opts.file } : {}),
          ...(opts.query ? { query: opts.query } : {}),
        };

        if (action === "list") {
          const findings = store
            .list(filter)
            .slice(0, parseInt(opts.limit, 10));
          if (findings.length === 0) {
            console.log("\n  No findings match the filter.\n");
            return;
          }
          console.log(`\n  Findings (${findings.length}):\n`);
          for (const f of findings) {
            const sev = sevColor(f.severity);
            const loc = f.lineStart ? `${f.file}:${f.lineStart}` : f.file;
            console.log(`  ${sev} [${f.category}] ${loc}`);
            console.log(`    id: ${f.id}`);
            console.log(`    ${f.title}`);
            if (f.description && f.description !== f.title) {
              console.log(`    ${f.description.slice(0, 120)}`);
            }
            if (f.suggestedFix) {
              console.log(`    Fix: ${f.suggestedFix.slice(0, 120)}`);
            }
            console.log();
          }
          return;
        }

        // Lookup helper for id-based actions
        const findById = (wantedId: string) =>
          store.list().find((f) => f.id === wantedId);

        if (action === "show") {
          if (!id) {
            console.error("  Usage: brainstorm findings show <id>");
            process.exit(1);
          }
          const f = findById(id);
          if (!f) {
            console.error(`  Finding not found: ${id}`);
            process.exit(1);
          }
          console.log();
          console.log(`  ${sevColor(f.severity)} [${f.category}]`);
          console.log(`  id:   ${f.id}`);
          console.log(
            `  file: ${f.file}${f.lineStart ? `:${f.lineStart}${f.lineEnd ? `-${f.lineEnd}` : ""}` : ""}`,
          );
          if (f.discoveredBy) console.log(`  by:   ${f.discoveredBy}`);
          console.log();
          console.log(`  ${f.title}`);
          console.log();
          console.log(`  ${f.description}`);
          if (f.suggestedFix) {
            console.log();
            console.log(`  Suggested fix:`);
            console.log(`  ${f.suggestedFix}`);
          }
          console.log();
          return;
        }

        if (action === "delete") {
          if (!id) {
            console.error("  Usage: brainstorm findings delete <id>");
            process.exit(1);
          }
          const ok = store.delete(id);
          if (!ok) {
            console.error(`  Finding not found: ${id}`);
            process.exit(1);
          }
          console.log(`  Deleted finding ${id}`);
          return;
        }

        if (action === "fix") {
          if (!id) {
            console.error("  Usage: brainstorm findings fix <id>");
            process.exit(1);
          }
          const finding = findById(id);
          if (!finding) {
            console.error(`  Finding not found: ${id}`);
            process.exit(1);
          }

          // Build the runtime the subagent will use — same shape as the
          // audit command, but with a `code` subagent that can write files.
          const config = loadConfig();
          config.general.defaultPermissionMode = "auto";
          const db = getDb();
          const resolvedKeys = await resolveProviderKeys();
          const registry = await createProviderRegistry(config, resolvedKeys);
          const costTracker = new CostTracker(db, config.budget);
          const tools = createDefaultToolRegistry();
          const { frontmatter } = buildSystemPrompt(process.cwd());
          const router = new BrainstormRouter(
            config,
            registry,
            costTracker,
            frontmatter,
          );
          router.setStrategy("capability");

          const { spawnSubagent } = await import("@brainst0rm/core");

          const loc = finding.lineStart
            ? `${finding.file}:${finding.lineStart}${finding.lineEnd ? `-${finding.lineEnd}` : ""}`
            : finding.file;

          console.log();
          console.log(`  Fixing: ${sevColor(finding.severity)} ${loc}`);
          console.log(`    ${finding.title}`);
          console.log();

          const task = [
            `Fix the following codebase audit finding.`,
            ``,
            `File: ${loc}`,
            `Severity: ${finding.severity}`,
            `Category: ${finding.category}`,
            ``,
            `Title: ${finding.title}`,
            ``,
            `Description:`,
            finding.description,
            ``,
            finding.suggestedFix
              ? `Suggested approach:\n${finding.suggestedFix}`
              : ``,
            ``,
            `Instructions:`,
            `1. Read the file and understand the surrounding context`,
            `2. Apply a focused fix for THIS specific finding only — do not refactor unrelated code`,
            `3. Verify the fix compiles (if applicable) by reading the result`,
            `4. Explain what you changed in 2-3 sentences`,
            ``,
            `Do NOT commit. Do NOT create new files unless strictly necessary.`,
          ]
            .filter(Boolean)
            .join("\n");

          const budgetLimit = parseFloat(opts.budget);
          let result: any;
          try {
            result = await spawnSubagent(task, {
              config,
              registry,
              router,
              costTracker,
              tools,
              projectPath: process.cwd(),
              type: "code",
              permissionCheck: () => "allow",
              budgetLimit,
              ...(opts.model ? { preferredModelId: opts.model } : {}),
            } as any);
          } catch (err: any) {
            // Surface the real error instead of letting it print as a raw
            // object and leaving the user wondering what happened.
            console.error(`\n  ✗ Subagent failed: ${err?.message ?? err}`);
            if (err?.data?.error?.message) {
              console.error(`    API error: ${err.data.error.message}`);
            }
            if (err?.statusCode) {
              console.error(`    Status:    ${err.statusCode}`);
            }
            console.error(
              `\n  The finding was not modified. You can retry with a different --model\n`,
            );
            process.exit(1);
          }

          const summary = result.text.trim();
          const toolCallCount = result.toolCalls.length;

          // Subagent completed but did nothing — distinguish "I looked and
          // decided nothing needed changing" from "I actually made an edit".
          // The agent's own tool-call list is the ground truth.
          const editTools = result.toolCalls.filter((t: string) =>
            /^(file_write|file_edit|file_append|multi_edit|patch)$/i.test(t),
          );

          console.log(`  Agent summary:`);
          console.log();
          if (summary) {
            console.log(
              summary
                .split("\n")
                .map((l: string) => `    ${l}`)
                .join("\n"),
            );
          } else {
            console.log(`    (no narrative output)`);
          }
          console.log();
          console.log(
            `  Model: ${result.modelUsed}   Cost: $${result.cost.toFixed(4)}   Tool calls: ${toolCallCount} (${editTools.length} edits)`,
          );
          if (result.budgetExceeded) {
            console.log(`  ⚠  Budget exceeded before completion`);
          }
          if (editTools.length === 0) {
            console.log(
              `  ⚠  Agent made no file edits. The finding is still present — consider a stronger model.`,
            );
          } else {
            console.log();
            console.log(
              `  Review the changes with git diff, then delete the finding:`,
            );
            console.log(`    brainstorm findings delete ${finding.id}`);
          }
          console.log();
          return;
        }

        if (action === "summary") {
          const summary = store.summary(filter);
          if (summary.total === 0) {
            console.log("\n  No findings recorded.");
            console.log(
              "  Run `brainstorm codebase audit` to populate findings.\n",
            );
            return;
          }

          console.log(`\n  Findings Summary — ${summary.total} total\n`);

          console.log(`  By severity:`);
          const sevOrder = [
            "critical",
            "high",
            "medium",
            "low",
            "info",
          ] as const;
          for (const sev of sevOrder) {
            const count = summary.bySeverity[sev];
            if (count > 0) {
              console.log(`    ${sevColor(sev).padEnd(12)} ${count}`);
            }
          }

          console.log(`\n  By category:`);
          const sortedCats = Object.entries(summary.byCategory).sort(
            (a, b) => b[1] - a[1],
          );
          for (const [cat, count] of sortedCats) {
            console.log(`    ${cat.padEnd(18)} ${count}`);
          }

          if (summary.byFile.length > 0) {
            console.log(`\n  Top files:`);
            for (const { file, count } of summary.byFile.slice(0, 10)) {
              console.log(`    ${count.toString().padStart(3)} ${file}`);
            }
          }

          if (summary.topCritical.length > 0) {
            console.log(`\n  Most urgent:`);
            for (const f of summary.topCritical) {
              const loc = f.lineStart ? `${f.file}:${f.lineStart}` : f.file;
              console.log(`    ${sevColor(f.severity)} ${loc}`);
              console.log(`      ${f.title}`);
            }
          }
          console.log();
          return;
        }

        console.error(`  Unknown action: ${action}. Use list or summary.`);
        process.exit(1);
      },
    );

  /** Simple severity label with emoji for scanability. */
  function sevColor(severity: string): string {
    switch (severity) {
      case "critical":
        return "🔴 CRITICAL";
      case "high":
        return "🟠 HIGH    ";
      case "medium":
        return "🟡 MEDIUM  ";
      case "low":
        return "🔵 LOW     ";
      case "info":
        return "⚪ INFO    ";
      default:
        return `   ${severity.toUpperCase().padEnd(8)}`;
    }
  }

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
          JSON.stringify(
            { todayCost, monthCost, byModel, byTaskType },
            null,
            2,
          ),
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

        // Phase 1: Analyze (surface scan)
        console.log(`  Phase 1: Analyzing codebase...`);
        const { analyzeProject, runDeepAnalysis } =
          await import("@brainst0rm/ingest");
        const analysis = analyzeProject(absPath);
        console.log(
          `    ✓ ${analysis.summary.totalFiles} files, ${analysis.summary.totalLines.toLocaleString()} lines, ${analysis.summary.moduleCount} modules`,
        );

        // Phase 1b: Deep AST analysis (tree-sitter → knowledge graph)
        if (opts.depth === "full") {
          console.log(`  Phase 1b: Deep analysis (tree-sitter AST)...`);
          try {
            analysis.graph = await runDeepAnalysis(absPath);
            console.log(
              `    ✓ ${analysis.graph.stats.nodes} nodes, ${analysis.graph.stats.graphEdges} edges, ` +
                `${analysis.graph.communities.length} communities (${analysis.graph.pipelineMs}ms)`,
            );
          } catch (err: any) {
            console.log(`    ✗ Deep analysis failed: ${err.message}`);
          }
        }

        // Phase 2: Generate docs
        console.log(`  Phase 2: Generating documentation...`);
        const { generateAllDocs } = await import("@brainst0rm/docgen");
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

          // Enrich with graph data
          if (analysis.graph) {
            const g = analysis.graph;
            lines.push(
              "",
              "## Knowledge Graph",
              "",
              `${g.stats.functions} functions, ${g.stats.classes} classes, ${g.stats.methods} methods.`,
              `${g.stats.callEdges} call edges, ${g.crossFile.resolved} cross-file resolved.`,
              `${g.communities.length} communities detected. Languages parsed: ${g.parsedLanguages.join(", ") || "none"}.`,
            );

            if (g.communities.length > 0) {
              lines.push("", "### Modules", "");
              for (const c of g.communities.slice(0, 15)) {
                lines.push(`- **${c.name ?? c.id}** — ${c.nodeCount} symbols`);
              }
            }

            if (g.callHotspots.length > 0) {
              lines.push("", "### Key Functions (most-called)", "");
              for (const h of g.callHotspots.slice(0, 10)) {
                lines.push(`- \`${h.name}\` — ${h.callerCount} callers`);
              }
            }
          }

          fsWrite(bmPath, lines.join("\n"), "utf-8");
          console.log(`    ✓ Generated BRAINSTORM.md`);
        }

        // Agent profiles — enriched with graph data when available
        const agentsDir = pathJoin(absPath, ".brainstorm", "agents");
        if (!existsSync(agentsDir)) fsMkdir(agentsDir, { recursive: true });
        let agentCount = 0;

        // If we have graph communities, use those for agent assignment (much better than directory clusters)
        const agentSources =
          analysis.graph && analysis.graph.communities.length > 0
            ? analysis.graph.communities.slice(0, 15).map((c) => ({
                name: c.name ?? c.id,
                nodeCount: c.nodeCount,
                complexityScore: c.complexityScore,
                // Find exports and hotspots belonging to this community
                exports: analysis
                  .graph!.exports.filter((e) => {
                    // Match exports to community by checking if the community name appears in the file path
                    const communityDir = (c.name ?? "").split("/")[0];
                    return communityDir && e.file.includes(communityDir);
                  })
                  .slice(0, 5),
                hotspots: analysis
                  .graph!.callHotspots.filter((h) => {
                    const communityDir = (c.name ?? "").split("/")[0];
                    return (
                      communityDir && h.file && h.file.includes(communityDir)
                    );
                  })
                  .slice(0, 5),
              }))
            : analysis.dependencies.clusters.slice(0, 10).map((c) => ({
                name: c.directory,
                nodeCount: c.files.length,
                complexityScore: null as number | null,
                exports: [] as Array<{
                  name: string;
                  kind: string;
                  file: string;
                  line: number;
                }>,
                hotspots: [] as Array<{
                  name: string;
                  callerCount: number;
                  file: string;
                }>,
              }));

        for (const source of agentSources) {
          const safeName = source.name.replace(/[/\\]/g, "-").replace(/^-/, "");
          if (!safeName) continue;
          const agentPath = pathJoin(agentsDir, `${safeName}.agent.md`);
          if (!existsSync(agentPath)) {
            const lines = [
              "---",
              `name: ${safeName}-expert`,
              "role: coder",
              "---",
              "",
              `# ${safeName} Expert`,
              "",
              `Domain expert for the ${safeName} module.`,
              `${source.nodeCount} symbols${source.complexityScore != null ? `, complexity: ${source.complexityScore}` : ""}.`,
            ];

            if (source.exports.length > 0) {
              lines.push("", "## Key Exports", "");
              for (const e of source.exports) {
                lines.push(`- \`${e.name}\` (${e.kind}) — ${e.file}:${e.line}`);
              }
            }

            if (source.hotspots.length > 0) {
              lines.push("", "## Call Hotspots", "");
              for (const h of source.hotspots) {
                lines.push(
                  `- \`${h.name}\` — ${h.callerCount} callers (${h.file})`,
                );
              }
            }

            lines.push("");
            fsWrite(agentPath, lines.join("\n"), "utf-8");
            agentCount++;
          }
        }
        console.log(`    ✓ ${agentCount} agent profiles created`);

        // Recipes
        const { initRecipeDir } = await import("@brainst0rm/workflow");
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
}
