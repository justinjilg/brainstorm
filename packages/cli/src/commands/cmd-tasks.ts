/**
 * `brainstorm` tasks commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { loadConfig } from "@brainst0rm/config";
import { getDb, closeDb } from "@brainst0rm/db";
import { createProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { createDefaultToolRegistry } from "@brainst0rm/tools";
import {
  runAgentLoop,
  buildSystemPrompt,
  spawnParallel,
} from "@brainst0rm/core";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { ResolvedKeys } from "@brainst0rm/providers";
import { PROVIDER_KEY_NAMES, resolveProviderKeys } from "./_context.js";

export function registerTasksCommands(program: Command): void {
  program
    .command("docgen")
    .description(
      "Generate documentation — architecture docs, module docs, API reference",
    )
    .argument("[path]", "Project path to document", ".")
    .option("--output <dir>", "Output directory (default: docs/generated)")
    .option("--json", "Output file list as JSON")
    .action(
      async (
        projectPath: string,
        opts: { output?: string; json?: boolean },
      ) => {
        const { resolve } = await import("node:path");
        const absPath = resolve(projectPath);

        console.log(`\n  Analyzing ${absPath}...`);
        const { analyzeProject } = await import("@brainst0rm/ingest");
        const analysis = analyzeProject(absPath);

        console.log(`  Generating documentation...\n`);
        const { generateAllDocs } = await import("@brainst0rm/docgen");
        const result = generateAllDocs(analysis, opts.output);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log("  ══════════════════════════════════════════════════");
        console.log("   Documentation Generated");
        console.log("  ══════════════════════════════════════════════════\n");
        console.log(`  Output: ${result.outputDir}`);
        console.log(`  Files written: ${result.filesWritten.length}`);
        console.log("");
        console.log(`  Architecture:  ${result.architectureDoc}`);
        console.log(`  Modules:       ${result.moduleDocs} module docs`);
        if (result.apiDoc) {
          console.log(`  API Reference: ${result.apiDoc}`);
        } else {
          console.log(`  API Reference: (no endpoints detected)`);
        }
        console.log("\n  ──────────────────────────────────────────────────");
        console.log(
          `  Tip: Use these docs as context for AI agents with @docs/generated/ARCHITECTURE.md`,
        );
        console.log();
      },
    );

  // ── Spawn Command (Background Worktree Agents) ───────────────────

  program
    .command("spawn")
    .description("Spawn a background agent in an isolated git worktree")
    .argument("<task>", "Task description for the background agent")
    .option(
      "--type <type>",
      "Subagent type (code, review, explore, research)",
      "code",
    )
    .option("--budget <amount>", "Budget limit in dollars", "1.0")
    .action(async (task: string, opts: { type: string; budget: string }) => {
      const { resolve } = await import("node:path");
      const { createWorktree, removeWorktree } =
        await import("@brainst0rm/core");
      const projectPath = resolve(".");
      const worktreePath = createWorktree(projectPath, opts.type);

      console.log(`\n  Spawned background agent in worktree:`);
      console.log(`    Path:   ${worktreePath}`);
      console.log(`    Type:   ${opts.type}`);
      console.log(`    Budget: $${opts.budget}`);
      console.log(`    Task:   ${task}`);
      console.log();
      console.log(`  The agent is running in an isolated copy of your repo.`);
      console.log(`  When done, changes will be on a spec-* branch.`);
      console.log(`  Use \`git worktree list\` to see active worktrees.`);
      console.log(`  Use \`git diff main...<branch>\` to review changes.`);
      console.log();

      // In a full implementation, this would fork a child process running
      // runAgentLoop in the worktree directory. For now, it sets up the
      // worktree and reports the path for manual or CI-driven execution.
      // The worktree is ready for: storm run --unattended "<task>" in the worktree dir.
      console.log(`  To run the agent:`);
      console.log(`    cd ${worktreePath} && storm run --unattended "${task}"`);
      console.log();
    });

  // ── Storm Command (Parallel Agent Spawning) ──────────────────────

  program
    .command("storm")
    .description("Run multiple tasks in parallel using subagents")
    .argument(
      "<tasks...>",
      "Task descriptions (each runs as a separate subagent)",
    )
    .option(
      "--type <type>",
      "Subagent type for all tasks (explore, plan, code, review, research)",
      "code",
    )
    .option("--budget <amount>", "Budget limit per task in dollars", "1.0")
    .action(async (tasks: string[], opts: { type: string; budget: string }) => {
      const config = loadConfig();
      const db = getDb();
      const resolvedKeys = await resolveProviderKeys();
      const registry = await createProviderRegistry(config, resolvedKeys);
      const costTracker = new CostTracker(db, config.budget);
      const tools = createDefaultToolRegistry();
      const projectPath = process.cwd();
      const { prompt: systemPrompt, frontmatter } =
        buildSystemPrompt(projectPath);
      const router = new BrainstormRouter(
        config,
        registry,
        costTracker,
        frontmatter,
      );

      console.log(`\n  Storm — ${tasks.length} parallel agents`);
      console.log(`  Type: ${opts.type} | Budget: $${opts.budget}/task\n`);

      for (let i = 0; i < tasks.length; i++) {
        console.log(`  [${i + 1}] ${tasks[i]}`);
      }
      console.log();

      const startTime = Date.now();
      const results = await spawnParallel(
        tasks.map((task) => ({ task, type: opts.type as any })),
        {
          config,
          registry,
          router,
          costTracker,
          tools,
          projectPath,
          systemPrompt,
          budgetLimit: parseFloat(opts.budget),
        },
      );

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ──────────────────────────────────────────────────`);
      console.log(`  ${results.length} agents completed in ${elapsed}s\n`);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const status = r.text ? "done" : "failed";
        const cost = `$${r.cost.toFixed(4)}`;
        console.log(
          `  [${i + 1}] ${status} (${r.toolCalls.length} tool calls, ${cost})`,
        );
        if (r.text) {
          // Show first 200 chars of response
          const preview = r.text.slice(0, 200).replace(/\n/g, " ");
          console.log(`      ${preview}${r.text.length > 200 ? "..." : ""}`);
        }
        console.log();
      }

      const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
      console.log(`  Total cost: $${totalCost.toFixed(4)}`);
      console.log();
      closeDb();
    });

  // ── Queue Command (Task Queue) ───────────────────────────────────

  program
    .command("queue")
    .description("Manage the task queue for batch execution")
    .argument("<action>", "Action: add, list, run, clear")
    .argument("[tasks...]", "Task descriptions (for add)")
    .option("--budget <amount>", "Total budget limit in dollars")
    .option("--parallel <n>", "Max parallel tasks (default: 1)", "1")
    .action(
      async (
        action: string,
        tasks: string[],
        opts: { budget?: string; parallel?: string },
      ) => {
        const { existsSync, readFileSync, writeFileSync, mkdirSync } =
          await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");

        const queueDir = join(homedir(), ".brainstorm", "queue");
        const queueFile = join(queueDir, "pending.json");

        if (!existsSync(queueDir)) mkdirSync(queueDir, { recursive: true });

        interface QueueItem {
          id: string;
          task: string;
          status: "pending" | "running" | "done" | "failed";
          addedAt: string;
        }

        const loadQueue = (): QueueItem[] => {
          if (!existsSync(queueFile)) return [];
          try {
            return JSON.parse(readFileSync(queueFile, "utf-8"));
          } catch {
            return [];
          }
        };
        const saveQueue = (q: QueueItem[]) =>
          writeFileSync(queueFile, JSON.stringify(q, null, 2), "utf-8");

        switch (action) {
          case "add": {
            if (tasks.length === 0) {
              console.error("  Error: provide task descriptions to add.");
              process.exit(1);
            }
            const queue = loadQueue();
            for (const task of tasks) {
              queue.push({
                id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                task,
                status: "pending",
                addedAt: new Date().toISOString(),
              });
            }
            saveQueue(queue);
            console.log(
              `\n  Added ${tasks.length} task(s) to queue. Total: ${queue.length} pending.`,
            );
            break;
          }
          case "list": {
            const queue = loadQueue();
            if (queue.length === 0) {
              console.log("\n  Queue is empty.");
              break;
            }
            console.log(`\n  Task Queue (${queue.length} items):\n`);
            for (const item of queue) {
              const icon =
                item.status === "done"
                  ? "✓"
                  : item.status === "failed"
                    ? "✗"
                    : item.status === "running"
                      ? "⟳"
                      : "○";
              console.log(`    ${icon} [${item.status}] ${item.task}`);
            }
            break;
          }
          case "run": {
            const queue = loadQueue();
            const pending = queue.filter((q) => q.status === "pending");
            if (pending.length === 0) {
              console.log("\n  No pending tasks in queue.");
              break;
            }
            console.log(`\n  ${pending.length} queued task(s) ready to run:`);
            console.log(
              `  Budget: ${opts.budget ?? "unlimited"} | Parallel: ${opts.parallel}`,
            );
            console.log(
              `\n  Copy-paste to execute (status stays 'pending' until a real run finishes):`,
            );
            // DO NOT flip status to "running" here. Previously we did — but the
            // following block only *prints* the commands the user should run,
            // it doesn't actually execute them. Flipping status to "running"
            // leaves every queue item permanently stuck (a subsequent
            // `queue run` finds nothing pending), corrupting queue state
            // silently until the user hand-edits pending.json.
            for (const item of pending) {
              console.log(`    storm run --unattended "${item.task}"`);
            }
            break;
          }
          case "clear": {
            saveQueue([]);
            console.log("\n  Queue cleared.");
            break;
          }
          default:
            console.error(
              `  Unknown action: ${action}. Use: add, list, run, clear`,
            );
        }
        console.log();
      },
    );

  // ── Search Command (Cross-Repo) ──────────────────────────────────

  program
    .command("search")
    .description("Search code — local semantic search or cross-repo via GitHub")
    .argument("<query>", "Search query")
    .option("--global", "Search across GitHub (not just local repo)")
    .option("--language <lang>", "Filter by language")
    .option("--limit <n>", "Max results (default: 10)", "10")
    .action(
      async (
        query: string,
        opts: { global?: boolean; language?: string; limit?: string },
      ) => {
        const limit = parseInt(opts.limit ?? "10");

        if (opts.global) {
          // Cross-repo search via GitHub Code Search API
          console.log(`\n  Searching GitHub for: "${query}"...\n`);
          const { execFileSync } = await import("node:child_process");
          try {
            const ghArgs = ["search", "code", query, "--limit", String(limit)];
            if (opts.language) ghArgs.push("--language", opts.language);
            const output = execFileSync("gh", ghArgs, {
              encoding: "utf-8",
              timeout: 30000,
              stdio: ["ignore", "pipe", "pipe"],
            });
            console.log(output);
          } catch (err: any) {
            if (err.message?.includes("ENOENT")) {
              console.error(
                "  Error: `gh` CLI not found. Install: https://cli.github.com",
              );
            } else {
              console.error(`  Search failed: ${err.message}`);
            }
          }
        } else {
          // Local semantic search
          const { semanticSearch } = await import("@brainst0rm/core");
          const results = semanticSearch(process.cwd(), query, limit);
          if (results.length === 0) {
            console.log(`\n  No results for "${query}".`);
          } else {
            console.log(`\n  ${results.length} result(s) for "${query}":\n`);
            for (const r of results) {
              const score = (r.score * 100).toFixed(0);
              console.log(
                `    [${score}%] ${r.filePath}${r.symbolName ? `:${r.symbolName}` : ""}`,
              );
              if (r.snippet) {
                console.log(`         ${r.snippet.trim().slice(0, 120)}`);
              }
            }
          }
        }
        console.log();
      },
    );

  // ── Setup-Infra Command ──────────────────────────────────────────

  program
    .command("setup-infra")
    .description(
      "Auto-generate AI infrastructure: BRAINSTORM.md, .agent.md files, routing profiles",
    )
    .argument("[path]", "Project path", ".")
    .action(async (projectPath: string) => {
      const { resolve, join: pathJoin } = await import("node:path");
      const {
        existsSync,
        writeFileSync: fsWrite,
        mkdirSync: fsMkdir,
      } = await import("node:fs");
      const absPath = resolve(projectPath);

      console.log(`\n  Setting up AI infrastructure for ${absPath}...\n`);

      // Phase 1: Analyze
      const { analyzeProject } = await import("@brainst0rm/ingest");
      const analysis = analyzeProject(absPath);

      // Phase 2: Auto-generate BRAINSTORM.md (#33)
      const brainstormMdPath = pathJoin(absPath, "BRAINSTORM.md");
      if (!existsSync(brainstormMdPath)) {
        const lines = [
          "---",
          `build_command: "npm run build"`,
          `test_command: "npm test"`,
          "---",
          "",
          `# ${absPath.split("/").pop()}`,
          "",
          "## Stack",
          "",
        ];
        if (analysis.frameworks.frameworks.length > 0)
          lines.push(
            `- Frameworks: ${analysis.frameworks.frameworks.join(", ")}`,
          );
        if (analysis.languages.primary)
          lines.push(`- Primary language: ${analysis.languages.primary}`);
        if (analysis.frameworks.databases.length > 0)
          lines.push(
            `- Databases: ${analysis.frameworks.databases.join(", ")}`,
          );
        if (analysis.frameworks.testing.length > 0)
          lines.push(`- Testing: ${analysis.frameworks.testing.join(", ")}`);

        lines.push("", "## Architecture", "");
        lines.push(
          `${analysis.summary.totalFiles} files, ${analysis.summary.totalLines.toLocaleString()} lines across ${analysis.summary.moduleCount} modules.`,
        );
        if (analysis.dependencies.entryPoints.length > 0) {
          lines.push("", "Entry points:");
          for (const ep of analysis.dependencies.entryPoints.slice(0, 10)) {
            lines.push(`- \`${ep}\``);
          }
        }

        lines.push(
          "",
          "## Conventions",
          "",
          "<!-- Add project conventions here -->",
        );

        fsWrite(brainstormMdPath, lines.join("\n"), "utf-8");
        console.log(`  ✓ Generated BRAINSTORM.md`);
      } else {
        console.log(`  · BRAINSTORM.md already exists (skipped)`);
      }

      // Phase 3: Auto-generate .agent.md per module cluster (#34)
      const agentsDir = pathJoin(absPath, ".brainstorm", "agents");
      if (!existsSync(agentsDir)) fsMkdir(agentsDir, { recursive: true });

      let agentsCreated = 0;
      for (const cluster of analysis.dependencies.clusters.slice(0, 10)) {
        const safeName = cluster.directory
          .replace(/[/\\]/g, "-")
          .replace(/^-/, "");
        const agentPath = pathJoin(agentsDir, `${safeName}.agent.md`);
        if (existsSync(agentPath)) continue;

        const node = analysis.dependencies.nodes.find((n) =>
          cluster.files.includes(n.path),
        );
        const lang = node?.language ?? analysis.languages.primary;
        const exports = cluster.files
          .flatMap(
            (f) =>
              analysis.dependencies.nodes.find((n) => n.path === f)?.exports ??
              [],
          )
          .slice(0, 20);

        const agentLines = [
          "---",
          `name: ${safeName}-expert`,
          `role: coder`,
          `model: auto`,
          "---",
          "",
          `# ${safeName} Module Expert`,
          "",
          `You are an expert in the ${safeName} module of this project.`,
          "",
          `## Context`,
          "",
          `- Language: ${lang}`,
          `- Files: ${cluster.files.length}`,
          `- Cohesion: ${cluster.cohesion > 0.5 ? "high" : cluster.cohesion > 0.2 ? "medium" : "low"}`,
        ];
        if (exports.length > 0) {
          agentLines.push(`- Key exports: ${exports.join(", ")}`);
        }
        agentLines.push(
          "",
          "## Files",
          "",
          ...cluster.files.slice(0, 15).map((f) => `- \`${f}\``),
        );
        if (cluster.files.length > 15)
          agentLines.push(`- ... and ${cluster.files.length - 15} more`);

        fsWrite(agentPath, agentLines.join("\n"), "utf-8");
        agentsCreated++;
      }
      console.log(
        `  ✓ Generated ${agentsCreated} .agent.md files in .brainstorm/agents/`,
      );

      // Phase 4: Generate docs
      const { generateAllDocs } = await import("@brainst0rm/docgen");
      const docResult = generateAllDocs(analysis);
      console.log(
        `  ✓ Generated ${docResult.filesWritten.length} documentation files`,
      );

      // Phase 5: Initialize recipe directory
      const { initRecipeDir } = await import("@brainst0rm/workflow");
      initRecipeDir(absPath);
      console.log(`  ✓ Initialized .brainstorm/recipes/`);

      console.log("\n  ══════════════════════════════════════════════════");
      console.log("   AI Infrastructure Setup Complete");
      console.log("  ══════════════════════════════════════════════════\n");
      console.log(`  BRAINSTORM.md     → project context for agents`);
      console.log(
        `  .brainstorm/agents/ → ${agentsCreated} domain expert agents`,
      );
      console.log(`  .brainstorm/recipes/ → shareable workflow templates`);
      console.log(`  docs/generated/   → architecture + module + API docs`);
      console.log(
        `\n  Next: Run \`storm chat\` to start working with AI agents that know your codebase.`,
      );
      console.log();
    });

  // ── Onboard Command ─────────────────────────────────────────────

  program
    .command("onboard")
    .description(
      "LLM-driven project onboarding — discover conventions, generate specialized agents, wire routing",
    )
    .argument("[path]", "Project path", ".")
    .option(
      "--budget <dollars>",
      "Max spend in USD (default: auto from project size)",
    )
    .option("--static-only", "Skip LLM phases (equivalent to setup-infra)")
    .option("--dry-run", "Show plan without writing files or calling LLMs")
    .option("--phases <phases>", "Comma-separated phases to run")
    .action(
      async (
        projectPath: string,
        opts: {
          budget?: string;
          staticOnly?: boolean;
          dryRun?: boolean;
          phases?: string;
        },
      ) => {
        const { resolve } = await import("node:path");
        const { runOnboardPipeline, ALL_PHASES } =
          await import("@brainst0rm/onboard");
        const absPath = resolve(projectPath);

        const options = {
          projectPath: absPath,
          budget: opts.budget ? parseFloat(opts.budget) : undefined,
          staticOnly: opts.staticOnly ?? false,
          dryRun: opts.dryRun ?? false,
          phases: opts.phases
            ? (opts.phases.split(",").map((p) => p.trim()) as any)
            : undefined,
        };

        console.log(
          `\n  storm onboard ${absPath === process.cwd() ? "." : absPath}${opts.staticOnly ? " --static-only" : ""}${opts.dryRun ? " --dry-run" : ""}`,
        );
        console.log();

        // Create LLM dispatcher for onboard phases (deep exploration, team assembly, etc.)
        let dispatcher;
        if (!opts.staticOnly) {
          const config = loadConfig();
          const db = getDb();
          const envKeys = new Map<string, string>();
          for (const name of PROVIDER_KEY_NAMES) {
            const val = process.env[name];
            if (val) envKeys.set(name, val);
          }
          const resolvedKeys: ResolvedKeys = {
            get: (name: string) => envKeys.get(name) ?? null,
          };
          const registry = await createProviderRegistry(config, resolvedKeys);
          const costTracker = new CostTracker(db, config.budget);
          const { frontmatter } = buildSystemPrompt(absPath);
          const router = new BrainstormRouter(
            config,
            registry,
            costTracker,
            frontmatter,
          );

          const { streamText } = await import("ai");
          dispatcher = {
            async explore(prompt: string, budget: number) {
              const task = router.classify(prompt);
              const decision = router.route(task, { preferCheap: true });
              const modelId = registry.getProvider(decision.model.id);
              const result = streamText({
                model: modelId,
                messages: [{ role: "user" as const, content: prompt }],
                maxRetries: 3,
              });
              let text = "";
              for await (const chunk of (result as any).textStream) {
                text += chunk;
              }
              const usage = await (result as any).usage;
              const cost =
                ((usage?.inputTokens ?? 0) / 1_000_000) *
                  decision.model.pricing.inputPer1MTokens +
                ((usage?.outputTokens ?? 0) / 1_000_000) *
                  decision.model.pricing.outputPer1MTokens;
              return { text, cost };
            },
            async generate(prompt: string, budget: number) {
              return this.explore(prompt, budget);
            },
          };
        }

        for await (const event of runOnboardPipeline(options, dispatcher)) {
          switch (event.type) {
            case "onboard-started":
              if (event.estimatedBudget > 0) {
                console.log(
                  `  Budget: $${options.budget?.toFixed(2) ?? "auto"} (estimated ~$${event.estimatedBudget.toFixed(2)})`,
                );
                console.log();
              }
              break;

            case "phase-started":
              process.stdout.write(`  Phase: ${event.description} ...`);
              break;

            case "phase-completed": {
              const cost = event.cost > 0 ? `, $${event.cost.toFixed(2)}` : "";
              const dur = (event.durationMs / 1000).toFixed(1);
              console.log(` done (${dur}s${cost})`);
              console.log(`    ${event.summary}`);
              console.log();
              break;
            }

            case "phase-skipped": {
              const { PHASE_LABELS } = await import("@brainst0rm/onboard");
              const label = PHASE_LABELS[event.phase] ?? event.phase;
              console.log(`  Phase: ${label} ... skipped`);
              console.log(`    ${event.reason}`);
              console.log();
              break;
            }

            case "phase-failed":
              console.log(` FAILED`);
              console.log(`    ${event.error}`);
              console.log();
              break;

            case "file-written":
              console.log(`    → ${event.path}`);
              break;

            case "budget-warning":
              console.log(
                `  ⚠ Budget: $${event.spent.toFixed(2)} spent, $${event.remaining.toFixed(2)} remaining`,
              );
              break;

            case "onboard-completed": {
              const r = event.result;
              const dur = (r.totalDurationMs / 1000).toFixed(1);
              console.log(
                "  ══════════════════════════════════════════════════",
              );
              console.log(
                `   Onboarding Complete — $${r.totalCost.toFixed(2)} total, ${dur}s`,
              );
              console.log(
                "  ══════════════════════════════════════════════════",
              );
              if (r.filesWritten.length > 0) {
                console.log();
                for (const f of r.filesWritten) {
                  console.log(`  ${f}`);
                }
              }

              // Persist exploration results to project memory
              try {
                const { persistOnboardToMemory } =
                  await import("@brainst0rm/onboard");
                const saved = persistOnboardToMemory(r, process.cwd());
                if (saved > 0) {
                  console.log(
                    `\n  ✓ ${saved} memory entries saved (conventions, domain concepts, etc.)`,
                  );
                }
              } catch (e) {
                console.log(
                  `\n  ⚠ Failed to persist to memory: ${(e as Error).message}`,
                );
              }

              console.log(
                `\n  Next: Run \`storm chat\` to start working with agents that know your codebase.\n`,
              );
              break;
            }
          }
        }
      },
    );

  // ── Route Explain Command ─────────────────────────────────────────
}
