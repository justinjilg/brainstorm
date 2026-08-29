/**
 * `brainstorm` setup commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { loadConfig } from "@brainst0rm/config";
import { getDb } from "@brainst0rm/db";
import { createProviderRegistry } from "@brainst0rm/providers";
import { BrainstormRouter, CostTracker } from "@brainst0rm/router";
import { createDefaultToolRegistry } from "@brainst0rm/tools";
import {
  buildSystemPrompt,
  spawnSubagent,
  describeFinishReason,
} from "@brainst0rm/core";
import { runInit } from "../init/index.js";
import { runEvalCli } from "@brainst0rm/eval";
import { join } from "node:path";
import { registerHarnessCommands } from "./harness.js";
import { registerA2ACommand } from "./a2a.js";
import { registerTraceCommand } from "./trace.js";
import { registerEvidenceCommand } from "./evidence.js";
import { registerLoginCommand } from "./login.js";
import { registerBackupCommand } from "./backup.js";
import {
  resolveProviderKeys,
  execFile,
  runBuildDoctorCheck,
  runEnvDoctorCheck,
  runModelDoctorCheck,
  printDoctorSection,
} from "./_context.js";

export function registerSetupCommands(program: Command): void {
  program
    .command("init")
    .description("Initialize project for AI-assisted development")
    .option("--yes", "Use defaults, skip prompts")
    .option("--force", "Overwrite existing files")
    .action(async (opts: { yes?: boolean; force?: boolean }) => {
      await runInit(process.cwd(), opts);
    });

  // `brainstorm harness …` — business-harness operator surface
  // (see packages/cli/src/commands/harness.ts and the spec at
  //  ~/.claude/plans/snuggly-sleeping-hinton.md ## Index Coherence)
  registerHarnessCommands(program);

  // Per-product status fetcher used by the `ecosystem` / `status` command below.
  // Lives in commands/status.ts so the rendering + fetch logic stays unit-testable.

  // `brainstorm a2a invoke` — operator-initiated A2A invocations.
  // See packages/cli/src/commands/a2a.ts (P2/Wk6 #67 of rev 2).
  registerA2ACommand(program);

  // `brainstorm trace <traceparent>` — walk a trace tree across all 4 layers.
  registerTraceCommand(program);

  // `brainstorm evidence verify --lineage <did>` — Phase G ratification
  // surface. See packages/cli/src/commands/evidence.ts (P5/Wk12 #73 of rev 2).
  registerEvidenceCommand(program);

  // `brainstorm login` — OAuth 2.0 Device Authorization Grant against
  // Keycloak at auth.brainstorm.co (v0.3 P1.5 / M4 / D12). Persists a
  // session to ~/.brainstorm/session.
  registerLoginCommand(program);

  // `brainstorm backup` — operate the brainstorm-backup product (schedules,
  // drills, runs). v0.6 P0 M02 — closes v0.5 M23 (the CLI subcommand
  // shipped at v0.5 M22a but never wired through the operator CLI).
  registerBackupCommand(program);

  program
    .command("eval")
    .description("Run capability evaluation probes against a model")
    .option(
      "--model <id>",
      "Model to evaluate (e.g., anthropic/claude-sonnet-4-6)",
    )
    .option("--capability <dim>", "Run only probes for this dimension")
    .option(
      "--compare",
      "Compare results across all previously evaluated models",
    )
    .option(
      "--scorecard",
      "Show current capability scores without re-running probes",
    )
    .option("--all-models", "Run probes against every available model")
    .option("--timeout <ms>", "Timeout per probe in milliseconds", "30000")
    .action(
      async (opts: {
        model?: string;
        capability?: string;
        compare?: boolean;
        scorecard?: boolean;
        allModels?: boolean;
        timeout?: string;
      }) => {
        await runEvalCli({
          model: opts.model,
          capability: opts.capability,
          compare: opts.compare,
          scorecard: opts.scorecard,
          allModels: opts.allModels,
          timeout: parseInt(opts.timeout ?? "30000"),
        });
      },
    );

  // ── SWE-bench Eval Command ────────────────────────────────────────

  program
    .command("eval-swe-bench")
    .description(
      "Run SWE-bench evaluation: apply agent to instances, score with Docker",
    )
    .requiredOption(
      "--instances <path>",
      "Path to SWE-bench instances.jsonl file",
    )
    .option("--model <id>", "Target model (default: let router decide)")
    .option("--limit <n>", "Max instances to evaluate", "10")
    .option("--concurrency <n>", "Parallel evaluations", "2")
    .option("--json", "Output results as JSON")
    .action(
      async (opts: {
        instances: string;
        model?: string;
        limit: string;
        concurrency: string;
        json?: boolean;
      }) => {
        const { loadInstances, runSWEBench, scorePatch, generateScorecard } =
          await import("@brainst0rm/eval");

        const limit = parseInt(opts.limit);
        const concurrency = parseInt(opts.concurrency);

        console.log(`\n  SWE-bench Evaluation`);
        console.log(`  ─────────────────────\n`);
        console.log(`  Instances: ${opts.instances}`);
        console.log(`  Limit: ${limit}`);
        console.log(`  Model: ${opts.model ?? "auto (router decides)"}`);
        console.log(`  Concurrency: ${concurrency}\n`);

        // Load instances
        const instances = loadInstances(opts.instances, limit);
        console.log(`  Loaded ${instances.length} instances.\n`);

        if (instances.length === 0) {
          console.error("  No instances found in file.");
          process.exit(1);
        }

        // Set up agent infrastructure (needed for spawnSubagent)
        const config = loadConfig();
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
        const { frontmatter } = buildSystemPrompt(process.cwd());
        const router = new BrainstormRouter(
          config,
          registry,
          costTracker,
          frontmatter,
        );
        if (!opts.model) {
          // Use the capability strategy so the router prefers models with
          // measured eval scores over assumed ones. quality-first picks by
          // qualityTier (a human guess) which can route to a model that
          // measured DEAD LAST in our own evals.
          router.setStrategy("capability");
        }

        const { execFileSync: execGit } = await import("node:child_process");
        const {
          mkdtempSync,
          writeFileSync: writePatch,
          rmSync,
        } = await import("node:fs");
        const { tmpdir } = await import("node:os");

        // Retry transient network failures (DNS/connection blips to GitHub or BR)
        // with bounded exponential backoff, so a hiccup during a multi-hour eval
        // doesn't miscount an instance as a capability failure. Only retries
        // errors that look transient — a real git/agent error still fails fast.
        const isTransientNet = (e: any): boolean => {
          const s = `${e?.code ?? ""} ${e?.reason ?? ""} ${e?.message ?? ""}`;
          return /ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNREFUSED|socket hang up|maxRetriesExceeded|Cannot connect to API/i.test(
            s,
          );
        };
        const withNetRetry = async <T>(
          fn: () => T | Promise<T>,
          attempts = 4,
        ): Promise<T> => {
          let lastErr: any;
          for (let i = 0; i < attempts; i++) {
            try {
              return await fn();
            } catch (e: any) {
              lastErr = e;
              if (!isTransientNet(e) || i === attempts - 1) throw e;
              await new Promise((r) => setTimeout(r, 2000 * 2 ** i)); // 2s,4s,8s
            }
          }
          throw lastErr;
        };

        let completed = 0;

        // Run agent on each instance — REAL implementation
        console.log(`  Running agent on ${instances.length} instances...\n`);
        const patches = await runSWEBench(
          instances,
          async (instance: any) => {
            const startTime = Date.now();
            const instanceNum = ++completed;
            const shortId = instance.instanceId.slice(0, 40);

            try {
              // Validate untrusted JSONL fields before they land as git argv.
              // execFile prevents shell injection, but git accepts positional
              // args that start with `-` as flags: a baseCommit of
              // "--upload-pack=/tmp/evil.sh" would execute arbitrary code
              // during git fetch. SWE-bench JSONLs are often loaded from
              // public mirrors or --instances URLs, so treat them as untrusted.
              if (!/^[0-9a-f]{7,64}$/.test(instance.baseCommit ?? "")) {
                throw new Error(
                  `invalid baseCommit (expected 7-64 hex chars): ${JSON.stringify(instance.baseCommit)}`,
                );
              }
              if (!/^[\w.-]+\/[\w.-]+$/.test(instance.repo ?? "")) {
                throw new Error(
                  `invalid repo (expected owner/name): ${JSON.stringify(instance.repo)}`,
                );
              }

              // 1. Create isolated workspace
              const workDir = mkdtempSync(join(tmpdir(), "swe-bench-"));
              const repoDir = join(workDir, "repo");

              try {
                // 2. Clone repo at baseCommit
                process.stderr.write(
                  `  [${instanceNum}/${instances.length}] ${shortId} — cloning...`,
                );
                // Use --filter=blob:none to avoid pulling full history while
                // still allowing checkout of any commit. --depth 100 was too
                // shallow for SWE-bench's historical commits.
                await withNetRetry(() =>
                  execGit(
                    "git",
                    [
                      "clone",
                      "--filter=blob:none",
                      "--no-checkout",
                      `https://github.com/${instance.repo}.git`,
                      "repo",
                    ],
                    {
                      cwd: workDir,
                      timeout: 180000,
                      stdio: ["ignore", "pipe", "pipe"],
                    },
                  ),
                );
                await withNetRetry(() =>
                  execGit("git", ["fetch", "origin", instance.baseCommit], {
                    cwd: repoDir,
                    timeout: 60000,
                    stdio: ["ignore", "pipe", "pipe"],
                  }),
                );
                execGit("git", ["checkout", instance.baseCommit], {
                  cwd: repoDir,
                  timeout: 30000,
                  stdio: ["ignore", "pipe", "pipe"],
                });

                // 3. Run Brainstorm agent on the issue
                process.stderr.write(` solving...`);
                const issuePrompt = [
                  `You are solving a GitHub issue in a cloned repository at \`${repoDir}\`.`,
                  ``,
                  `## Problem`,
                  instance.issue,
                  instance.hints ? `\n## Hints\n${instance.hints}` : "",
                  ``,
                  `## Required Output`,
                  `You MUST modify source files in this repo to fix the issue.`,
                  `An empty diff counts as a failure. Your job is to edit code.`,
                  ``,
                  `## Steps`,
                  `1. Use glob/grep/file_read to find the relevant source files`,
                  `2. Identify the root cause by reading the actual code`,
                  `3. Use file_edit or file_write to apply the fix (this step is REQUIRED)`,
                  `4. Do NOT modify test files — only source files`,
                  `5. Verify your changes by re-reading the modified files`,
                  `6. Report what files you changed and why`,
                  ``,
                  `If you finish without calling file_edit or file_write at least once, you have failed the task.`,
                ].join("\n");

                // Retry once on a transient network failure to BR — network
                // blips almost always hit the first model call, before any edit.
                const result = await withNetRetry(
                  () =>
                    spawnSubagent(issuePrompt, {
                      config,
                      registry,
                      router,
                      costTracker,
                      tools,
                      projectPath: repoDir,
                      type: "code",
                      maxSteps: 40, // SWE-bench issues need room for exploration + edits + verification
                      budgetLimit: 3.0,
                      permissionCheck: () => "allow", // unattended — auto-approve everything
                      // Honor --model flag if provided — otherwise subagent
                      // re-routes internally and ignores parent's preference.
                      preferredModelId: opts.model,
                    }),
                  2,
                );

                // 4. Capture the diff (what the agent actually changed)
                let patch = "";
                try {
                  patch = execGit("git", ["diff"], {
                    cwd: repoDir,
                    encoding: "utf-8",
                    timeout: 10000,
                    stdio: ["ignore", "pipe", "pipe"],
                  }) as unknown as string;

                  // Also capture any new untracked files
                  const untrackedDiff = execGit("git", ["diff", "--cached"], {
                    cwd: repoDir,
                    encoding: "utf-8",
                    timeout: 10000,
                    stdio: ["ignore", "pipe", "pipe"],
                  }) as unknown as string;
                  if (untrackedDiff) patch += "\n" + untrackedDiff;
                } catch {
                  // git diff failed — no changes made
                }

                // Distinguish a genuine empty answer from a provider-terminated
                // one (e.g. content-filter moderation) so an empty patch isn't
                // silently reported as "no changes" when the provider refused.
                const finishNote = describeFinishReason(result.finishReason);
                const success = patch.length > 0 && !result.budgetExceeded;
                const status = success
                  ? "✓"
                  : result.budgetExceeded
                    ? "budget exceeded"
                    : finishNote
                      ? `no changes (${result.finishReason})`
                      : "no changes";
                process.stderr.write(
                  ` ${status} ($${result.cost.toFixed(3)}, ${result.modelUsed})\n`,
                );
                // Diagnostic: on no-changes, surface WHY — the provider finish
                // reason if it wasn't a normal stop, then what the subagent said.
                if (!success && patch.length === 0) {
                  if (finishNote) {
                    process.stderr.write(`    reason: ${finishNote}\n`);
                  }
                  const preview = result.text.slice(0, 500).replace(/\n/g, " ");
                  process.stderr.write(`    agent said: ${preview}\n`);
                }

                return {
                  instanceId: instance.instanceId,
                  patch,
                  model: result.modelUsed,
                  strategy: opts.model ? "forced" : "quality-first",
                  cost: result.cost,
                  latencyMs: Date.now() - startTime,
                  success,
                };
              } finally {
                // Cleanup workspace
                try {
                  rmSync(workDir, { recursive: true, force: true });
                } catch {
                  /* best effort */
                }
              }
            } catch (err: any) {
              process.stderr.write(
                ` ERROR: ${(err.message ?? "").slice(0, 80)}\n`,
              );
              return {
                instanceId: instance.instanceId,
                patch: "",
                model: "error",
                strategy: "quality-first",
                cost: 0,
                latencyMs: Date.now() - startTime,
                success: false,
              };
            }
          },
          concurrency,
        );

        // Score patches
        console.log(`  Scoring ${patches.length} patches...`);
        const scores = patches.map((patch: any, i: number) =>
          scorePatch(instances[i], patch),
        );
        const scorecard = generateScorecard(patches, scores);

        if (opts.json) {
          console.log(JSON.stringify(scorecard, null, 2));
          return;
        }

        console.log(`\n  ══════════════════════════════════════════════════`);
        console.log(`   SWE-bench Results`);
        console.log(`  ══════════════════════════════════════════════════\n`);
        console.log(`  Total:     ${scorecard.total}`);
        console.log(
          `  Passed:    ${scorecard.passed} (${(scorecard.passRate * 100).toFixed(1)}%)`,
        );
        console.log(`  Failed:    ${scorecard.failed}`);
        console.log(`  Errored:   ${scorecard.errored}`);
        console.log(`  Cost:      $${scorecard.totalCost.toFixed(4)}`);
        console.log(`  Avg Lat:   ${scorecard.avgLatencyMs}ms`);

        // Print individual errors to help diagnose scorer failures
        const erroredScores = scores.filter((s: any) => s.error);
        if (erroredScores.length > 0) {
          console.log(`\n  Scoring errors (${erroredScores.length}):`);
          for (const s of erroredScores) {
            console.log(`    ${s.instanceId}: ${s.error}`);
          }
        }
        console.log();
      },
    );

  // ── Doctor Command ────────────────────────────────────────────────

  program
    .command("doctor")
    .description("Check project health, environment, and model availability")
    .action(async () => {
      const cwd = process.cwd();

      console.log(`\n  Brainstorm Doctor`);
      console.log(`  ─────────────────`);

      const [buildResult, modelsResult] = await Promise.all([
        runBuildDoctorCheck(cwd),
        runModelDoctorCheck(),
      ]);

      const envResult = runEnvDoctorCheck(cwd);

      printDoctorSection(buildResult);
      printDoctorSection(envResult);
      printDoctorSection(modelsResult);
      console.log();

      const allResults = [
        ...buildResult.results,
        ...envResult.results,
        ...modelsResult.results,
      ];
      const hasFailures = allResults.some((r) => r.status === "fail");

      if (hasFailures) {
        process.exit(1);
      }
    });

  // ── Router Commands (BrainstormRouter Gateway) ───────────────────
}
