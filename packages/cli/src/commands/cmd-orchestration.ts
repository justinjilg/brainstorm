/**
 * `brainstorm` orchestration commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { loadConfig } from "@brainst0rm/config";
import { getDb } from "@brainst0rm/db";
import { createProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { createDefaultToolRegistry } from "@brainst0rm/tools";
import { buildSystemPrompt, spawnSubagent } from "@brainst0rm/core";
import {
  createGatewayClient,
  createIntelligenceClient,
} from "@brainst0rm/gateway";
import { join } from "node:path";
import type { ResolvedKeys } from "@brainst0rm/providers";
import { PROVIDER_KEY_NAMES, resolveProviderKeys } from "./_context.js";

export function registerOrchestrationCommands(program: Command): void {
  const planCmd = program
    .command("plan")
    .description("Execute and manage structured plans");

  planCmd
    .command("execute")
    .argument("<path>", "Path to .plan.md file")
    .option("--auto", "Run autonomously (no pauses)")
    .option("--dry-run", "Show dispatch plan without executing")
    .option("--budget <amount>", "Total budget limit in dollars")
    .option("--task-budget <amount>", "Per-task budget limit", "0.50")
    .option("--retries <n>", "Max retries per task", "2")
    .description("Execute a plan file task-by-task using subagents")
    .action(async (path: string, opts: any) => {
      const { executePlan } = await import("@brainst0rm/core");
      const { resolve } = await import("node:path");
      const { execFileSync } = await import("node:child_process");

      const planPath = resolve(path);
      const mode = opts.dryRun
        ? "dry-run"
        : opts.auto
          ? "autonomous"
          : "interactive";

      console.log(`\n  Plan Executor (${mode} mode)\n`);

      const dispatcher = {
        async execute(prompt: string, execOpts: any) {
          console.log(
            `    Dispatching: ${execOpts.subagentType}/${execOpts.modelHint}`,
          );
          return {
            text: `[Placeholder] Completed via ${execOpts.subagentType} subagent`,
            cost: 0,
            modelUsed: execOpts.modelHint,
            toolCalls: [],
            budgetExceeded: false,
          };
        },
        async checkBuild(command: string, cwd: string) {
          const parts = command.split(/\s+/);
          try {
            execFileSync(parts[0], parts.slice(1), {
              cwd,
              timeout: 60000,
              stdio: "pipe",
            });
            return { passed: true, output: "" };
          } catch (err: any) {
            return {
              passed: false,
              output: err.stderr?.toString()?.slice(0, 500) ?? "",
            };
          }
        },
      };

      try {
        for await (const event of executePlan(planPath, dispatcher, {
          projectPath: process.cwd(),
          buildCommand: "npx turbo run build --force",
          defaultBudgetPerTask: parseFloat(opts.taskBudget),
          planBudgetLimit: opts.budget ? parseFloat(opts.budget) : undefined,
          mode,
          maxRetries: parseInt(opts.retries),
          compactBetweenPhases: true,
        })) {
          switch (event.type) {
            case "plan-started":
              console.log(`  Plan: ${event.plan.name}`);
              console.log(`  Tasks: ${event.totalTasks} pending\n`);
              break;
            case "phase-started":
              console.log(`  ── ${event.phase.name} ──`);
              break;
            case "sprint-started":
              console.log(`    ${event.sprint.name}`);
              break;
            case "task-started":
              console.log(
                `    ● ${event.task.description.slice(0, 60)} [${event.subagentType}/${event.model}]`,
              );
              break;
            case "task-completed":
              console.log(
                `    ✓ ${event.task.description.slice(0, 60)}  $${event.cost.toFixed(4)}`,
              );
              break;
            case "task-failed":
              console.log(
                `    ✗ ${event.task.description.slice(0, 60)}  ${event.reason}`,
              );
              break;
            case "task-retrying":
              console.log(`    ↻ Retry #${event.attempt} with ${event.model}`);
              break;
            case "task-budget-exceeded":
              console.log(`    $ Budget exceeded: $${event.cost.toFixed(4)}`);
              break;
            case "build-check":
              console.log(
                `    ${event.passed ? "✓" : "✗"} Build ${event.passed ? "passed" : "FAILED"}`,
              );
              break;
            case "phase-completed":
              console.log(
                `  ✓ ${event.phase.name} complete  $${event.cost.toFixed(4)}\n`,
              );
              break;
            case "plan-completed":
              console.log(`  ═══════════════════════════════`);
              console.log(
                `  Plan complete: $${event.totalCost.toFixed(4)} total\n`,
              );
              break;
            case "plan-paused":
              console.log(`\n  ⚠ Paused: ${event.reason}\n`);
              break;
            case "skill-activated":
              console.log(`    ✦ Skill: ${event.skillName}`);
              break;
            case "dry-run-task": {
              const d = event.dispatch;
              console.log(
                `    ○ ${event.task.description.slice(0, 45).padEnd(47)} ${d.subagentType.padEnd(10)} ${d.modelHint.padEnd(10)} ~$${event.estimatedCost.toFixed(2)}`,
              );
              break;
            }
            case "dry-run-summary":
              console.log(
                `\n  Summary: ${event.totalTasks} tasks, ~$${event.estimatedCost.toFixed(2)} estimated`,
              );
              console.log(
                `  By type: ${Object.entries(event.tasksByType)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(", ")}\n`,
              );
              break;
          }
        }
      } catch (err) {
        console.error(
          `\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });

  planCmd
    .command("parse")
    .argument("<path>", "Path to .plan.md file")
    .description("Parse and display a plan file structure")
    .action(async (path: string) => {
      const { parsePlanFile } = await import("@brainst0rm/core");
      const { resolve } = await import("node:path");
      let plan;
      try {
        plan = parsePlanFile(resolve(path));
      } catch (err) {
        console.error(
          `\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return;
      }

      console.log(`\n  ${plan.name} (${plan.status})`);
      console.log(
        `  ${plan.completedTasks}/${plan.totalTasks} tasks complete\n`,
      );

      for (const phase of plan.phases) {
        const icon =
          phase.status === "completed"
            ? "✓"
            : phase.status === "in_progress"
              ? "◐"
              : "○";
        console.log(
          `  ${icon} ${phase.name}  ${phase.completedCount}/${phase.taskCount}`,
        );
        for (const sprint of phase.sprints) {
          console.log(`    ${sprint.name}`);
          for (const task of sprint.tasks) {
            const tIcon = task.status === "completed" ? "✓" : "○";
            const cost = task.cost ? `$${task.cost.toFixed(2)}` : "";
            const skill = task.assignedSkill ? `[${task.assignedSkill}]` : "";
            console.log(`      ${tIcon} ${task.description} ${skill} ${cost}`);
          }
        }
      }
      console.log();
    });

  // ── Orchestrate Command ───────────────────────────────────────────

  const orchestrateCmd = program
    .command("orchestrate")
    .description("Coordinate work across multiple projects");

  orchestrateCmd
    .command("pipeline")
    .argument("<request>", "What to build (natural language)")
    .option("--build <cmd>", "Build command", "npx turbo run build --force")
    .option("--test <cmd>", "Test command", "npx turbo run test")
    .option("--deploy", "Include deployment phase")
    .option("--budget <amount>", "Total budget limit in dollars")
    .option(
      "--phases <list>",
      "Comma-separated phases to run (spec,architecture,implementation,review,verify,refactor,deploy,document,report)",
    )
    .option("--resume-from <phase>", "Resume from a specific phase")
    .option("--dry-run", "Show what agents would be dispatched")
    .description("Run the full 9-phase development pipeline")
    .action(async (request: string, opts: any) => {
      const { runOrchestrationPipeline, createPipelineDispatcher } =
        await import("@brainst0rm/core");

      console.log(`\n  Orchestration Pipeline\n`);
      console.log(`  Request: "${request}"`);
      console.log(`  Mode: ${opts.dryRun ? "dry-run" : "execute"}\n`);

      // Set up real runtime — env vars only (no vault prompt for non-interactive pipeline)
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
      const projectPath = process.cwd();
      const tools = createDefaultToolRegistry();
      const { frontmatter } = buildSystemPrompt(projectPath);
      const router = new BrainstormRouter(
        config,
        registry,
        costTracker,
        frontmatter,
      );

      // Create real dispatcher — wired to spawnSubagent() with agent.md definitions
      const dispatcher = createPipelineDispatcher({
        config,
        registry,
        router,
        costTracker,
        tools,
        projectPath,
      });

      // Fallback: if no provider keys, use placeholder
      const hasProviders = PROVIDER_KEY_NAMES.some(
        (k) => resolvedKeys.get(k) !== null,
      );
      if (!hasProviders && !opts.dryRun) {
        console.log(
          "  ⚠ No model providers configured. Using placeholder dispatcher.",
        );
        console.log("  Set API keys via: storm vault add ANTHROPIC_API_KEY\n");
      }

      const activeDispatcher =
        hasProviders || opts.dryRun
          ? dispatcher
          : {
              async runPhase(
                agentId: string,
                subagentType: string,
                prompt: string,
                phaseOpts: any,
              ) {
                console.log(`    Agent: ${agentId} (${subagentType})`);
                return {
                  text: `[No providers] ${agentId} would execute`,
                  cost: 0,
                  toolCalls: [],
                };
              },
              async runParallel(specs: any[], phaseOpts: any) {
                return specs.map((s: any) => {
                  console.log(`    Agent: ${s.agentId} (${s.subagentType})`);
                  return {
                    agentId: s.agentId,
                    text: `[No providers] ${s.agentId} would execute`,
                    cost: 0,
                    toolCalls: [],
                  };
                });
              },
              async runCommand(command: string, cwd: string) {
                const { execFileSync } = await import("node:child_process");
                const parts = command.split(/\s+/);
                try {
                  execFileSync(parts[0], parts.slice(1), {
                    cwd,
                    timeout: 120000,
                    stdio: "pipe",
                  });
                  return { passed: true, output: "" };
                } catch (err: any) {
                  return {
                    passed: false,
                    output: err.stderr?.toString()?.slice(0, 500) ?? "",
                  };
                }
              },
            };

      const phases = opts.phases?.split(",") ?? undefined;

      for await (const event of runOrchestrationPipeline(
        request,
        activeDispatcher,
        {
          projectPath,
          buildCommand: opts.build,
          testCommand: opts.test,
          deploy: opts.deploy,
          budget: opts.budget ? parseFloat(opts.budget) : undefined,
          phases,
          resumeFrom: opts.resumeFrom,
          dryRun: opts.dryRun,
        },
      )) {
        switch (event.type) {
          case "pipeline-started":
            console.log(`  Phases: ${event.phases.join(" → ")}\n`);
            break;
          case "phase-started":
            console.log(
              `  ── ${event.phase.toUpperCase()} ──  (${event.agentId})`,
            );
            break;
          case "phase-completed":
            const icon = event.result.success ? "✓" : "✗";
            console.log(
              `  ${icon} ${event.result.phase}  $${event.result.cost.toFixed(4)}  ${event.result.duration}ms`,
            );
            if (event.result.output && !event.result.output.startsWith("[")) {
              console.log(
                `    ${event.result.output.split("\n")[0].slice(0, 100)}`,
              );
            }
            console.log();
            break;
          case "phase-failed":
            console.log(`  ✗ ${event.phase}: ${event.error}\n`);
            break;
          case "review-findings":
            console.log(
              `  Reviews: ${event.findings.length} finding(s)${event.hasCritical ? " (CRITICAL)" : ""}`,
            );
            for (const f of event.findings.slice(0, 5)) {
              console.log(`    [${f.severity}] ${f.description.slice(0, 80)}`);
            }
            console.log();
            break;
          case "feedback-loop":
            console.log(
              `  ↻ Feedback: ${event.from} → ${event.to} (${event.reason})\n`,
            );
            break;
          case "pipeline-completed":
            console.log(`  ═══════════════════════════════════`);
            console.log(
              `  Pipeline complete: $${event.totalCost.toFixed(4)} total`,
            );
            console.log(
              `  ${event.results.filter((r) => r.success).length}/${event.results.length} phases succeeded\n`,
            );
            break;
          case "pipeline-paused":
            console.log(`  ⚠ Paused at ${event.phase}: ${event.reason}\n`);
            break;
        }
      }
    });

  orchestrateCmd
    .command("run")
    .argument("<description>", "What to do across projects")
    .requiredOption("-p, --projects <names>", "Comma-separated project names")
    .option("--budget <amount>", "Total budget limit in dollars")
    .option("--type <type>", "Subagent type (explore, code, review)", "code")
    .description("Run a cross-project orchestration")
    .action(
      async (
        description: string,
        opts: { projects: string; budget?: string; type: string },
      ) => {
        const {
          OrchestrationEngine,
          formatAggregatedResults,
          aggregateResults,
        } = await import("@brainst0rm/orchestrator");
        const { ProjectManager } = await import("@brainst0rm/projects");
        const db = getDb();
        const engine = new OrchestrationEngine(db);
        const pm = new ProjectManager(db);

        const projectNames = opts.projects
          .split(",")
          .map((s: string) => s.trim());

        console.log(
          `\n  Orchestrating across ${projectNames.length} projects...`,
        );
        console.log(`  "${description}"\n`);

        try {
          for await (const event of engine.run({
            description,
            projectNames,
            budgetLimit: opts.budget ? parseFloat(opts.budget) : undefined,
            subagentType: opts.type,
          })) {
            switch (event.type) {
              case "plan-ready":
                console.log(`  Plan: ${event.tasks.length} tasks created`);
                break;
              case "task-started":
                console.log(`  ● ${event.project.name} — starting...`);
                break;
              case "task-completed":
                console.log(
                  `  ✓ ${event.project.name} — $${event.cost.toFixed(4)}`,
                );
                if (event.summary)
                  console.log(`    ${event.summary.slice(0, 120)}`);
                break;
              case "task-failed":
                console.log(`  ✗ ${event.project.name} — ${event.error}`);
                break;
              case "orchestration-completed": {
                const projectMap = new Map<string, string>();
                for (const name of projectNames) {
                  const p = pm.projects.getByName(name);
                  if (p) projectMap.set(p.id, p.name);
                }
                const tasks = event.results.map((r, i) => ({
                  ...event.run,
                  projectId: projectMap.get(r.projectName) ?? r.projectName,
                }));
                console.log(`\n  ── Complete ──`);
                console.log(`  Total cost: $${event.run.totalCost.toFixed(4)}`);
                console.log(
                  `  ${event.results.filter((r) => !r.summary.startsWith("FAILED")).length}/${event.results.length} succeeded\n`,
                );
                break;
              }
            }
          }
        } catch (err) {
          console.error(
            `\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      },
    );

  orchestrateCmd
    .command("history")
    .option("-n, --limit <count>", "Number of runs to show", "10")
    .description("Show recent orchestration runs")
    .action(async (opts: { limit: string }) => {
      const { OrchestrationEngine } = await import("@brainst0rm/orchestrator");
      const db = getDb();
      const engine = new OrchestrationEngine(db);
      const runs = engine.listRecent(parseInt(opts.limit));

      console.log("\n  Orchestration History:\n");
      if (runs.length === 0) {
        console.log("    No orchestration runs yet.\n");
        return;
      }
      for (const r of runs) {
        const icon =
          r.status === "completed"
            ? "✓"
            : r.status === "failed"
              ? "✗"
              : r.status === "cancelled"
                ? "○"
                : "●";
        const date = new Date(r.createdAt * 1000).toLocaleString();
        console.log(
          `    ${icon} ${r.name.slice(0, 40).padEnd(42)} $${r.totalCost.toFixed(4).padEnd(10)} ${r.status.padEnd(12)} ${date}`,
        );
      }
      console.log();
    });

  orchestrateCmd
    .command("parallel")
    .argument(
      "<request>",
      "High-level request to decompose into parallel tasks",
    )
    .option("--workers <n>", "Concurrent workers (default 3)", "3")
    .option(
      "--budget <amount>",
      "Budget cap for the entire run in dollars",
      "5",
    )
    .option(
      "--no-merge",
      "Do not auto-merge approved worktrees — leave for human review",
    )
    .option(
      "--skip-build-verify",
      "Skip per-worktree build verification (faster but less safe)",
    )
    .option(
      "--model <id>",
      "Pin planner + workers to a specific model id (e.g. brainstormrouter/auto), bypassing capability routing",
    )
    .option(
      "--panel <name>",
      "Merge gate: run a diverse judge panel ('merge-gate' = 3 provider-diverse LLM judges + build/test, majority + security veto) instead of the deterministic judge. Enables per-task contracts. Default: deterministic judge (today's behavior).",
    )
    .option(
      "--revise-max <n>",
      "Merge gate: max automatic revise rounds when the panel returns 'revise'. Each round re-runs the failed tasks under the same contract with corrective feedback + a rotated model. Requires --panel. Overrides [orchestrator.revise].maxIterations. Default 0 (off).",
    )
    .description(
      "Plan → parallel workers → judge: decompose a request, run N workers in isolated worktrees, merge approved branches",
    )
    .action(
      async (
        request: string,
        opts: {
          workers: string;
          budget: string;
          merge?: boolean;
          skipBuildVerify?: boolean;
          model?: string;
          panel?: string;
          reviseMax?: string;
        },
      ) => {
        const {
          planMultiAgentRun,
          runWorkerPool,
          runJudge,
          runGateWithRevise,
        } = await import("@brainst0rm/core");
        const { DEFAULT_PANELS } = await import("@brainst0rm/contracts");

        const projectPath = process.cwd();
        const concurrency = parseInt(opts.workers, 10);
        const budgetLimit = parseFloat(opts.budget);
        const autoMerge = opts.merge !== false;

        // Set up runtime — same pattern as other CLI commands
        const config = loadConfig();

        // Panel merge gate: --panel wins, else optional [orchestrator] panel TOML.
        // Absent → deterministic judge (today's behavior), no contracts emitted.
        const panelName = opts.panel ?? config.orchestrator?.panel ?? undefined;
        const panelConfig = panelName ? DEFAULT_PANELS[panelName] : undefined;
        if (panelName && !panelConfig) {
          console.error(
            `  Unknown panel '${panelName}'. Available: ${Object.keys(DEFAULT_PANELS).join(", ")}\n`,
          );
          process.exit(1);
        }
        const usePanel = Boolean(panelConfig);

        // Revise loop: --revise-max wins, else [orchestrator.revise].maxIterations,
        // else 0 (off — exact current behavior). Only meaningful with a panel.
        const maxReviseIterations =
          opts.reviseMax !== undefined
            ? Math.max(0, parseInt(opts.reviseMax, 10) || 0)
            : (config.orchestrator?.revise?.maxIterations ?? 0);

        console.log(`\n  Multi-Agent Parallel Orchestration\n`);
        console.log(`  Request:  "${request.slice(0, 80)}"`);
        console.log(`  Workers:  ${concurrency} concurrent`);
        console.log(`  Budget:   $${budgetLimit.toFixed(2)}`);
        console.log(`  Merge:    ${autoMerge ? "auto on approve" : "manual"}`);
        console.log(
          `  Gate:     ${usePanel ? `panel '${panelName}'` : "deterministic judge"}`,
        );
        if (usePanel && maxReviseIterations > 0) {
          console.log(
            `  Revise:   up to ${maxReviseIterations} round(s)${opts.model ? ` (rotation skipped: run pinned to ${opts.model})` : ""}`,
          );
        }
        console.log();

        config.general.defaultPermissionMode = "auto"; // unattended
        const db = getDb();
        const resolvedKeys = await resolveProviderKeys();
        // Persist BR's x-br-* routing envelope on this unattended path too —
        // the listener was previously wired only on the chat path, so agent
        // fleets discarded the routing rationale for every completion they made.
        const {
          RoutingAuditRepository: FleetAuditRepo,
          wireRoutingAudit: wireFleetAudit,
        } = await import("@brainst0rm/db");
        const registry = await createProviderRegistry(config, resolvedKeys, {
          onEnvelope: wireFleetAudit(new FleetAuditRepo(db)),
        });
        const costTracker = new CostTracker(db, config.budget);
        const tools = createDefaultToolRegistry();
        const { frontmatter } = buildSystemPrompt(projectPath);
        const router = new BrainstormRouter(
          config,
          registry,
          costTracker,
          frontmatter,
        );
        // A pinned model bypasses per-subagent routing entirely (see
        // spawnSubagent's preferredModelId handling), so the capability
        // strategy only matters when no model is pinned.
        if (!opts.model) {
          router.setStrategy("capability");
        }

        // Resolve the project ID — orchestration_runs needs an FK target
        const { ProjectManager } = await import("@brainst0rm/projects");
        const pm = new ProjectManager(db);
        const project = pm.projects.getByPath(projectPath);
        if (!project) {
          console.error(
            `  No project registered for ${projectPath}. Run 'brainstorm projects add' first.\n`,
          );
          process.exit(1);
        }

        const sharedSubagentOptions: any = {
          config,
          registry,
          router,
          costTracker,
          tools,
          projectPath,
          permissionCheck: () => "allow",
          budgetLimit: budgetLimit / Math.max(1, concurrency * 2),
          // When set, planner + every worker pin to this model instead of
          // letting the router pick one the gateway may not be able to serve.
          ...(opts.model ? { preferredModelId: opts.model } : {}),
        };

        // ── Phase 1: Planner ────────────────────────────────────────────
        console.log(`  [Planner] decomposing request...`);
        let plan;
        try {
          plan = await planMultiAgentRun({
            request,
            projectId: project.id,
            budgetLimit,
            subagentOptions: sharedSubagentOptions,
            db,
            // The panel gate reviews against per-task contracts; emit them.
            emitContracts: usePanel,
          });
        } catch (err: any) {
          console.error(`  ✗ Planner failed: ${err.message}\n`);
          process.exit(1);
        }
        console.log(
          `  [Planner] done — ${plan.subtaskCount} subtasks, ${plan.totalDependencies} edges, $${plan.cost.toFixed(4)} (${plan.modelUsed})`,
        );
        console.log(`  [Planner] strategy: ${plan.summary.slice(0, 200)}\n`);

        // Shared worker-pool event printer. `attempt` labels revise rounds.
        const printPoolEvent = (event: any, attempt = 0): void => {
          const tag = attempt > 0 ? `[revise ${attempt}] ` : "";
          switch (event.type) {
            case "worker-claimed":
              console.log(
                `  ${tag}[${event.workerId}] claimed: ${event.task?.prompt.slice(0, 60)}...`,
              );
              break;
            case "worker-completed":
              console.log(
                `  ${tag}[${event.workerId}] ✓ ($${event.cost?.toFixed(4)}, ${event.filesTouched?.length ?? 0} files)`,
              );
              break;
            case "worker-failed":
              console.log(
                `  ${tag}[${event.workerId}] ✗ ${event.error?.slice(0, 80) ?? "failed"}`,
              );
              break;
            case "pool-finished":
              console.log(
                `  ${tag}[Workers] done — ${event.totalCompleted} completed, ${event.totalFailed} failed`,
              );
              break;
          }
        };

        // ── Phase 2/3: Worker Pool → Judge / Panel gate ─────────────────
        // The panel path runs pool + gate inside runGateWithRevise so a 'revise'
        // decision can drive a bounded retry loop (maxReviseIterations=0 → one
        // pool pass + one gate = exact legacy behavior). The deterministic judge
        // path keeps its own single pool pass.
        let decision: "approve" | "revise" | "reject";
        let mergedTaskIds: string[];
        let panelCost = 0;
        let poolCost = 0;

        if (usePanel && panelConfig) {
          console.log(`  [Workers] starting ${concurrency} workers...`);
          const result = await runGateWithRevise({
            runId: plan.runId,
            db,
            projectPath,
            panel: panelConfig,
            subagentOptions: sharedSubagentOptions,
            registry,
            getModels: () => router.getModels(),
            skipBuildVerify: opts.skipBuildVerify ?? false,
            autoMerge,
            concurrency,
            maxReviseIterations,
            ...(opts.model ? { pinnedModelId: opts.model } : {}),
            onPoolEvent: (e, attempt) => printPoolEvent(e, attempt),
            onGate: (gate, attempt) => {
              const label = attempt > 0 ? ` (revise ${attempt})` : "";
              console.log(
                `\n  [Panel]${label} decision: ${gate.panelDecision.decision.toUpperCase()} (${gate.panelDecision.quorum.rule}: ${gate.panelDecision.quorum.achieved}/${gate.panelDecision.quorum.required})`,
              );
              for (const line of gate.panelDecision.combinedRationale.split(
                "\n",
              )) {
                console.log(`    ${line}`);
              }
              if (gate.panelDecision.dissent.length > 0) {
                console.log(`  [Panel] dissent:`);
                for (const d of gate.panelDecision.dissent.slice(0, 5)) {
                  console.log(`    - ${d.slice(0, 160)}`);
                }
              }
              if (gate.mergedTaskIds.length > 0) {
                console.log(
                  `  [Panel] merged ${gate.mergedTaskIds.length} task branch(es) into ${projectPath}`,
                );
              }
            },
            onRevise: (records, attempt) => {
              console.log(
                `  [Revise ${attempt}] re-enqueued ${records.length} task(s):`,
              );
              for (const r of records) {
                console.log(
                  `    - ${r.originalTaskId.slice(0, 8)} → ${r.newTaskId.slice(0, 8)} (${r.rotation})`,
                );
              }
            },
          });
          decision = result.panelDecision.decision;
          mergedTaskIds = result.mergedTaskIds;
          panelCost = result.totalPanelCost;
          poolCost = result.totalPoolCost;
          if (result.exhausted) {
            console.log(
              `  [Revise] budget exhausted after ${result.reviseIterations} round(s) — contract(s) marked failed, not merged.`,
            );
          }
        } else {
          console.log(`  [Workers] starting ${concurrency} workers...`);
          let poolResult: any;
          const eventGen = runWorkerPool({
            runId: plan.runId,
            db,
            subagentOptions: sharedSubagentOptions,
            concurrency,
            preserveWorktrees: true,
          });
          while (true) {
            const next = await eventGen.next();
            if (next.done) {
              poolResult = next.value;
              break;
            }
            printPoolEvent(next.value);
          }
          poolCost = poolResult?.totalCost ?? 0;

          console.log(`\n  [Judge] verifying worktrees...`);
          const verdict = await runJudge({
            runId: plan.runId,
            db,
            projectPath,
            skipBuildVerify: opts.skipBuildVerify ?? false,
            autoMerge,
          });
          decision = verdict.decision;
          mergedTaskIds = verdict.mergedTaskIds;
          console.log(
            `  [Judge] decision: ${verdict.decision.toUpperCase()} (${verdict.reason})`,
          );
          const conflicts = Object.keys(verdict.conflictMatrix);
          if (conflicts.length > 0) {
            console.log(`  [Judge] conflicts on ${conflicts.length} files:`);
            for (const file of conflicts.slice(0, 10)) {
              console.log(
                `    ${file} (tasks: ${verdict.conflictMatrix[file].join(", ")})`,
              );
            }
          }
          if (mergedTaskIds.length > 0) {
            console.log(
              `  [Judge] merged ${mergedTaskIds.length} task branch(es) into ${projectPath}`,
            );
          }
        }

        console.log(
          `\n  Total cost: $${(plan.cost + poolCost + panelCost).toFixed(4)}`,
        );
        console.log(`  Run id: ${plan.runId}`);
        console.log();

        process.exit(decision === "approve" ? 0 : 1);
      },
    );

  orchestrateCmd
    .command("status")
    .argument("<run-id>", "Orchestration run ID")
    .description("Show status of an orchestration run")
    .action(async (runId: string) => {
      const { OrchestrationEngine } = await import("@brainst0rm/orchestrator");
      const { ProjectManager } = await import("@brainst0rm/projects");
      const db = getDb();
      const engine = new OrchestrationEngine(db);
      const pm = new ProjectManager(db);
      const detail = engine.getRunWithTasks(runId);
      if (!detail) {
        console.error(`  Run "${runId}" not found.\n`);
        return;
      }

      console.log(`\n  ── ${detail.run.name} ──`);
      console.log(`  Status: ${detail.run.status}`);
      console.log(`  Cost:   $${detail.run.totalCost.toFixed(4)}`);
      console.log(`  Tasks:  ${detail.tasks.length}\n`);

      for (const t of detail.tasks) {
        const project = pm.projects.getById(t.projectId);
        const icon =
          t.status === "completed"
            ? "✓"
            : t.status === "failed"
              ? "✗"
              : t.status === "skipped"
                ? "○"
                : "●";
        console.log(
          `    ${icon} ${(project?.name ?? t.projectId.slice(0, 8)).padEnd(25)} ${t.status.padEnd(12)} $${t.cost.toFixed(4)}`,
        );
        if (t.resultSummary)
          console.log(`      ${t.resultSummary.slice(0, 100)}`);
      }
      console.log();
    });

  // ── Intelligence Command ───────────────────────────────────────────

  program
    .command("intelligence")
    .alias("intel")
    .description("Show what BrainstormRouter has learned about your usage")
    .option("--json", "Output as JSON")
    .option(
      "--period <period>",
      "Usage period (daily, weekly, monthly)",
      "weekly",
    )
    .action(async (opts: { json?: boolean; period: string }) => {
      const gw = createGatewayClient();
      const intel = createIntelligenceClient();

      if (!gw) {
        console.log(
          "\n  No BRAINSTORM_API_KEY set. Cannot connect to BrainstormRouter.\n",
        );
        process.exit(1);
      }

      console.log("\n  Fetching intelligence from BrainstormRouter...\n");

      // Fetch all data in parallel — graceful fallback on each endpoint
      const [
        leaderboard,
        usage,
        waste,
        forecast,
        daily,
        governance,
        recommendations,
        patterns,
      ] = await Promise.all([
        gw.getLeaderboard().catch(() => []),
        gw.getUsageSummary(opts.period).catch(() => null),
        gw.getWasteInsights().catch(() => null),
        gw.getForecast().catch(() => null),
        gw.getDailyInsights().catch(() => []),
        gw.getGovernanceSummary().catch(() => null),
        intel?.getRecommendations("code", "typescript").catch(() => []) ?? [],
        intel?.getPatterns("typescript").catch(() => []) ?? [],
      ]);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              leaderboard,
              usage,
              waste,
              forecast,
              daily,
              governance,
              recommendations,
              patterns,
            },
            null,
            2,
          ),
        );
        return;
      }

      // ── Header ──
      console.log("  ══════════════════════════════════════════════════");
      console.log("   BrainstormRouter Intelligence Report");
      console.log("  ══════════════════════════════════════════════════\n");

      // ── Learning Status ──
      // Usage shape: { data: [{ requestCount, totalCostUsd, ... }] }
      const usageData = (usage as any)?.data?.[0];
      const totalRequests = usageData?.requestCount ?? 0;
      const confidence =
        totalRequests >= 200 ? "HIGH" : totalRequests >= 50 ? "MEDIUM" : "LOW";
      const confidenceNote =
        confidence === "LOW"
          ? ` (need ${200 - totalRequests} more for high confidence)`
          : "";
      console.log(
        `  Learning Status: ${totalRequests.toLocaleString()} requests analyzed`,
      );
      console.log(`  Routing Confidence: ${confidence}${confidenceNote}\n`);

      // ── Model Performance ──
      // Leaderboard shape: { id, model_id, reward_score, value_score, latency_ms, sample_count, ... }
      const realLeaderboard = leaderboard.filter(
        (m: any) => m.id && !m.id.startsWith("cache/"),
      );
      if (realLeaderboard.length > 0) {
        console.log("  Model Performance:\n");
        for (const entry of realLeaderboard.slice(0, 8)) {
          const m = entry as any;
          const modelName = m.model_id ?? m.id ?? m.model ?? "unknown";
          const name =
            modelName.length > 35 ? modelName.slice(0, 35) + "…" : modelName;
          const latency =
            m.latency_ms != null
              ? m.latency_ms < 1000
                ? `${Math.round(m.latency_ms)}ms`
                : `${(m.latency_ms / 1000).toFixed(1)}s`
              : "  n/a";
          const reward =
            m.reward_score != null
              ? (m.reward_score * 100).toFixed(0) + "%"
              : "n/a";
          const value =
            m.value_score != null ? m.value_score.toFixed(0) : "n/a";
          const samples = m.sample_count ?? m.request_count ?? 0;
          const isBest = entry === realLeaderboard[0] ? " ← BEST" : "";
          console.log(
            `    ${name.padEnd(37)} reward:${reward.padStart(4)} value:${value.padStart(5)} ${latency.padStart(6)} (${samples} samples)${isBest}`,
          );
        }
        console.log();
      }

      // ── What the System Learned ──
      if (recommendations.length > 0) {
        console.log("  What the system learned:\n");
        for (const rec of recommendations.slice(0, 5)) {
          const r = rec as any;
          const conf =
            r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "";
          console.log(
            `    • ${r.taskType} → ${r.recommendedModel} (${conf} confidence)`,
          );
          if (r.reasoning) {
            console.log(`      ${r.reasoning}`);
          }
        }
        console.log();
      }

      // ── Cost Intelligence ──
      if (usageData) {
        const totalTokens =
          (usageData.totalInputTokens ?? 0) +
          (usageData.totalOutputTokens ?? 0);
        console.log("  Cost Summary:\n");
        console.log(
          `    Period:       ${(usage as any)?.period ?? opts.period}`,
        );
        console.log(
          `    Total:        $${(usageData.totalCostUsd ?? 0).toFixed(4)}`,
        );
        console.log(
          `    Requests:     ${(usageData.requestCount ?? 0).toLocaleString()}`,
        );
        console.log(`    Tokens:       ${totalTokens.toLocaleString()}`);
        console.log(
          `    Avg latency:  ${(usageData.avgLatencyMs ?? 0).toFixed(0)}ms`,
        );
        console.log();
      }

      // ── Budget Forecast ──
      // Forecast shape: { forecast: { avgDailySpendUsd, trend, confidence, projectedPeriodSpendUsd }, todaySpendUsd, daysOfData }
      const fc = (forecast as any)?.forecast;
      if (fc) {
        const trend = fc.trend ?? "stable";
        const trendIcon =
          trend === "increasing" ? "↑" : trend === "decreasing" ? "↓" : "→";
        console.log("  Budget Forecast:\n");
        console.log(
          `    Avg daily:   $${(fc.avgDailySpendUsd ?? 0).toFixed(2)} (${trendIcon} ${trend})`,
        );
        console.log(
          `    Projected:   $${(fc.projectedPeriodSpendUsd ?? 0).toFixed(2)}`,
        );
        console.log(
          `    Today:       $${((forecast as any)?.todaySpendUsd ?? 0).toFixed(4)}`,
        );
        console.log(
          `    Data points: ${(forecast as any)?.daysOfData ?? 0} days`,
        );
        console.log();
      }

      // ── Waste Insights ──
      // Waste shape: { estimatedWasteUsd, overQualifiedModels: [...], duplicateRequests: [...] }
      const wasteAny = waste as any;
      if (
        wasteAny &&
        (wasteAny.overQualifiedModels?.length > 0 ||
          wasteAny.duplicateRequests?.length > 0)
      ) {
        console.log("  Optimization Opportunities:\n");
        console.log(
          `    Total recoverable: $${(wasteAny.estimatedWasteUsd ?? 0).toFixed(4)}\n`,
        );
        for (const m of (wasteAny.overQualifiedModels ?? []).slice(0, 3)) {
          console.log(
            `    • ${m.model}: $${m.totalCostUsd.toFixed(4)} on ${m.requestCount} reqs`,
          );
          console.log(`      → ${m.suggestion}`);
        }
        const dupeCount = (wasteAny.duplicateRequests ?? []).length;
        if (dupeCount > 0) {
          const totalDupeWaste = (wasteAny.duplicateRequests ?? []).reduce(
            (sum: number, d: any) => sum + (d.wastedCostUsd ?? 0),
            0,
          );
          console.log(
            `    • ${dupeCount} duplicate request patterns ($${totalDupeWaste.toFixed(4)} wasted)`,
          );
          console.log(`      → Enable prompt caching to reduce duplicates`);
        }
        console.log();
      }

      // ── Community Patterns ──
      if (patterns.length > 0) {
        console.log("  Community Patterns (TypeScript):\n");
        for (const p of patterns.slice(0, 3)) {
          const pat = p as any;
          console.log(
            `    • ${pat.taskType}: prefer ${(pat.preferredTools ?? []).join(", ")} (${pat.confirmations ?? 0} confirmations)`,
          );
          if (pat.avoidTools?.length > 0) {
            console.log(`      avoid: ${pat.avoidTools.join(", ")}`);
          }
        }
        console.log();
      }

      // ── Governance ──
      if (governance) {
        const gov = governance as any;
        console.log("  Governance:\n");
        if (gov.memory_health) {
          console.log(
            `    Memory:   ${gov.memory_health.total_entries} entries (${gov.memory_health.compliance_status})`,
          );
        }
        if (gov.audit_stats) {
          console.log(
            `    Audit:    ${gov.audit_stats.total_requests} requests, ${gov.audit_stats.flagged} flagged`,
          );
        }
        if (gov.anomaly_score != null) {
          console.log(
            `    Anomaly:  ${gov.anomaly_score.toFixed(2)} (0=clean, 1=suspicious)`,
          );
        }
        console.log();
      }

      console.log("  ──────────────────────────────────────────────────");
      console.log(
        `  Tip: Run \`storm intel --json\` for machine-readable output.`,
      );
      console.log();
    });

  // ── Analyze Command ───────────────────────────────────────────────

  program
    .command("analyze")
    .description(
      "Analyze a codebase — languages, frameworks, dependencies, complexity",
    )
    .argument("[path]", "Project path to analyze", ".")
    .option("--json", "Output as JSON")
    .option(
      "--deep",
      "Run deep AST analysis with tree-sitter (builds call graph, detects communities)",
    )
    .action(
      async (projectPath: string, opts: { json?: boolean; deep?: boolean }) => {
        const { resolve } = await import("node:path");
        const absPath = resolve(projectPath);

        console.log(`\n  Analyzing ${absPath}...\n`);
        const startTime = Date.now();

        const { analyzeProject, runDeepAnalysis } =
          await import("@brainst0rm/ingest");
        const analysis = analyzeProject(absPath);

        // Deep analysis: tree-sitter AST parsing → SQLite graph → communities
        if (opts.deep) {
          console.log(`  Running deep analysis (tree-sitter AST parsing)...`);
          try {
            analysis.graph = await runDeepAnalysis(absPath);
            console.log(
              `    ✓ ${analysis.graph.stats.nodes} nodes, ${analysis.graph.stats.graphEdges} edges, ` +
                `${analysis.graph.communities.length} communities (${analysis.graph.pipelineMs}ms)\n`,
            );
          } catch (err: any) {
            console.log(`    ✗ Deep analysis failed: ${err.message}\n`);
          }
        }

        const elapsed = Date.now() - startTime;

        if (opts.json) {
          console.log(JSON.stringify(analysis, null, 2));
          return;
        }

        console.log("  ══════════════════════════════════════════════════");
        console.log("   Codebase Analysis");
        console.log("  ══════════════════════════════════════════════════\n");

        console.log(
          `  ${analysis.summary.totalFiles} files | ${analysis.summary.totalLines.toLocaleString()} lines | ${analysis.summary.primaryLanguage}`,
        );
        console.log(
          `  ${analysis.summary.moduleCount} modules | avg complexity: ${analysis.summary.avgComplexity}/100 | ${elapsed}ms\n`,
        );

        // Languages
        console.log("  Languages:");
        for (const l of analysis.languages.languages.slice(0, 8)) {
          const bar = "█".repeat(Math.max(1, Math.round(l.percentage / 5)));
          console.log(
            `    ${l.language.padEnd(15)} ${bar} ${l.percentage}% (${l.files} files, ${l.lines.toLocaleString()} lines)`,
          );
        }

        // Frameworks
        const hasStack =
          analysis.frameworks.frameworks.length > 0 ||
          analysis.frameworks.buildTools.length > 0;
        if (hasStack) {
          console.log("\n  Stack:");
          if (analysis.frameworks.frameworks.length > 0)
            console.log(
              `    Frameworks:  ${analysis.frameworks.frameworks.join(", ")}`,
            );
          if (analysis.frameworks.buildTools.length > 0)
            console.log(
              `    Build:       ${analysis.frameworks.buildTools.join(", ")}`,
            );
          if (analysis.frameworks.databases.length > 0)
            console.log(
              `    Databases:   ${analysis.frameworks.databases.join(", ")}`,
            );
          if (analysis.frameworks.testing.length > 0)
            console.log(
              `    Testing:     ${analysis.frameworks.testing.join(", ")}`,
            );
          if (analysis.frameworks.deployment.length > 0)
            console.log(
              `    Deploy:      ${analysis.frameworks.deployment.join(", ")}`,
            );
          if (analysis.frameworks.ci.length > 0)
            console.log(
              `    CI/CD:       ${analysis.frameworks.ci.join(", ")}`,
            );
        }

        // Complexity hotspots
        if (analysis.complexity.summary.hotspots.length > 0) {
          console.log("\n  Complexity Hotspots (score > 70):");
          for (const f of analysis.complexity.files
            .filter((cf: any) => cf.score >= 70)
            .slice(0, 8)) {
            console.log(
              `    ${f.path.padEnd(50)} score:${f.score} branches:${f.branchCount} nesting:${f.maxNesting}`,
            );
          }
        }

        // Module clusters
        if (analysis.dependencies.clusters.length > 0) {
          console.log("\n  Module Clusters (by size):");
          for (const c of analysis.dependencies.clusters.slice(0, 8)) {
            const cohesionLabel =
              c.cohesion > 0.5 ? "high" : c.cohesion > 0.2 ? "med" : "low";
            console.log(
              `    ${c.directory.padEnd(40)} ${c.files.length} files  cohesion:${cohesionLabel}`,
            );
          }
        }

        // Deep graph results
        if (analysis.graph) {
          const g = analysis.graph;
          console.log("\n  Knowledge Graph (tree-sitter AST):");
          console.log(
            `    ${g.stats.functions} functions | ${g.stats.classes} classes | ${g.stats.methods} methods`,
          );
          console.log(
            `    ${g.stats.callEdges} call edges | ${g.crossFile.resolved} cross-file resolved`,
          );
          console.log(
            `    ${g.communities.length} communities | languages: ${g.parsedLanguages.join(", ") || "none"}`,
          );

          if (g.exports.length > 0) {
            console.log(`\n  Top Exports:`);
            for (const e of g.exports.slice(0, 10)) {
              console.log(
                `    ${e.kind.padEnd(10)} ${e.name.padEnd(40)} ${e.file}:${e.line}`,
              );
            }
          }

          if (g.callHotspots.length > 0) {
            console.log(`\n  Call Hotspots (most-called symbols):`);
            for (const h of g.callHotspots.slice(0, 10)) {
              console.log(
                `    ${String(h.callerCount).padStart(4)} callers  ${h.name.padEnd(40)} ${h.file ?? "unknown"}`,
              );
            }
          }

          if (g.communities.length > 0) {
            console.log(`\n  Communities (Louvain):`);
            for (const c of g.communities.slice(0, 10)) {
              console.log(
                `    ${(c.name ?? c.id).padEnd(40)} ${c.nodeCount} nodes`,
              );
            }
          }
        }

        console.log("\n  ──────────────────────────────────────────────────");
        if (!analysis.graph) {
          console.log(
            `  Run \`storm analyze --deep\` for AST-based knowledge graph.`,
          );
        }
        console.log(
          `  Run \`storm analyze --json\` for machine-readable output.`,
        );
        console.log();
      },
    );

  // ── Docgen Command ────────────────────────────────────────────────
}
