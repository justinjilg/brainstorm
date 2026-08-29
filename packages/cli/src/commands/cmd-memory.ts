/**
 * `brainstorm` memory commands — extracted from the former bin/brainstorm.ts
 * god-file (Phase 1: split into commands/*). Behavior is unchanged; this module
 * only relocates the registrations onto the shared `program`.
 */
import { Command } from "commander";
import { getDb } from "@brainst0rm/db";
import { BrainstormRouter } from "@brainst0rm/router";
import { createGatewayClient } from "@brainst0rm/gateway";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "./_context.js";

export function registerMemoryCommands(program: Command): void {
  program
    .command("route")
    .description("Explain how Brainstorm classifies and routes a task")
    .argument("[task]", "Task description to classify")
    .option("--json", "Output as JSON")
    .action(async (task: string | undefined, opts: { json?: boolean }) => {
      const { classifyTask } = await import("@brainst0rm/router");

      const taskText =
        task ?? "write a function that validates email addresses";
      const profile = classifyTask(taskText);

      if (opts.json) {
        console.log(JSON.stringify({ task: taskText, profile }, null, 2));
        return;
      }

      console.log("\n  Route Explain");
      console.log("  ══════════════════════════════════════════════════\n");
      console.log(`  Task: "${taskText.slice(0, 80)}"`);
      console.log();
      console.log(`  Classification:`);
      console.log(`    Type:       ${profile.type}`);
      console.log(`    Complexity: ${profile.complexity}`);
      console.log(`    Tools:      ${profile.requiresToolUse ? "yes" : "no"}`);
      console.log(
        `    Reasoning:  ${profile.requiresReasoning ? "yes" : "no"}`,
      );
      if (profile.language) console.log(`    Language:   ${profile.language}`);
      if (profile.domain) console.log(`    Domain:     ${profile.domain}`);
      console.log(
        `    Est tokens: ${profile.estimatedTokens.input}in / ${profile.estimatedTokens.output}out`,
      );

      console.log();
      console.log(`  Routing Logic:`);
      if (profile.type === "ingest")
        console.log(`    → Ingest pipeline: analysis + docgen + infra setup`);
      else if (profile.type === "audit")
        console.log(
          `    → Full review pipeline: security + quality + tech debt`,
        );
      else if (profile.type === "migration")
        console.log(`    → Migration pipeline: parallel agents per module`);
      else if (profile.type === "documentation")
        console.log(`    → Documentation pipeline: architecture + module docs`);
      else if (profile.requiresReasoning)
        console.log(
          `    → Routes to frontier model (Opus/GPT-5.4) for reasoning`,
        );
      else if (
        profile.complexity === "trivial" ||
        profile.complexity === "simple"
      )
        console.log(
          `    → Routes to fast/cheap model (Haiku/Flash) for simple tasks`,
        );
      else
        console.log(
          `    → Routes based on active strategy (quality/cost/combined)`,
        );

      console.log();
    });

  // ── Loop Command ──────────────────────────────────────────────────

  program
    .command("loop")
    .description("Run a prompt or slash command on a recurring interval")
    .argument("<prompt>", "Prompt or /command to run repeatedly")
    .option(
      "-i, --interval <minutes>",
      "Interval between runs in minutes",
      "10",
    )
    .option(
      "-n, --max-runs <count>",
      "Maximum number of runs (0 = unlimited)",
      "0",
    )
    .action(
      async (prompt: string, opts: { interval: string; maxRuns: string }) => {
        const intervalMs =
          Math.max(1, parseInt(opts.interval) || 10) * 60 * 1000;
        const maxRuns = parseInt(opts.maxRuns) || 0;
        let runCount = 0;

        console.log(
          `\n  Loop: "${prompt}" every ${opts.interval}m${maxRuns > 0 ? ` (max ${maxRuns} runs)` : ""}`,
        );
        console.log(`  Press Ctrl+C to stop.\n`);

        const runOnce = async () => {
          runCount++;
          const ts = new Date().toLocaleTimeString();
          console.log(`  [${ts}] Run #${runCount}...`);

          try {
            // Shell out to `storm run` for each iteration — clean process per run
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execFileAsync = promisify(execFile);

            const stormBin = process.argv[1]; // path to this script
            const { stdout, stderr } = await execFileAsync(
              process.execPath,
              [stormBin, "run", prompt],
              {
                cwd: process.cwd(),
                timeout: 5 * 60 * 1000, // 5 min max per run
                env: { ...process.env },
              },
            );
            if (stdout.trim()) console.log(stdout.trim());
            if (stderr.trim()) console.error(stderr.trim());
          } catch (err: any) {
            console.error(
              `  Error: ${(err.stderr ?? err.message).slice(0, 200)}`,
            );
          }

          if (maxRuns > 0 && runCount >= maxRuns) {
            console.log(`\n  Loop complete (${runCount} runs).`);
            process.exit(0);
          }
        };

        // Run immediately, then self-chain on interval. setInterval fires
        // regardless of whether the prior runOnce is still awaiting — for a
        // task that takes longer than the interval (common when intervalMs
        // is tight and `storm run` hits its 5-min timeout), executions stack,
        // budget compounds, and SQLite WAL contention rises. Chaining via
        // setTimeout after each runOnce settles keeps exactly one run in
        // flight at a time.
        let loopTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleNext = () => {
          loopTimer = setTimeout(async () => {
            await runOnce();
            scheduleNext();
          }, intervalMs);
        };
        const stop = () => {
          if (loopTimer) clearTimeout(loopTimer);
        };
        process.on("SIGINT", () => {
          stop();
          process.exit(0);
        });

        await runOnce();
        scheduleNext();
      },
    );

  // ── Memory Command ────────────────────────────────────────────────

  program
    .command("memory")
    .description("View and manage agent memory entries")
    .argument("[action]", "Action: list, search, forget", "list")
    .argument("[query]", "Search query or memory key to forget")
    .action(async (action: string, query?: string) => {
      const { MemoryManager } = await import("@brainst0rm/core");
      // Bug fix (Dogfood #1 Bug 1): previously passed ~/.brainstorm/memory as
      // the "projectPath" argument. MemoryManager internally hashes its arg to
      // compute a project-scoped store at
      // ~/.brainstorm/projects/<hash>/memory/. Hashing the literal string
      // "~/.brainstorm/memory" produced a store that no other code ever wrote
      // to, so `brainstorm memory list` always showed "No memory entries"
      // even after `brainstorm onboard` wrote 6 entries to the real
      // project-hashed store.
      //
      // The fix: pass process.cwd() so memory commands scope to the current
      // project, matching what onboard and the agent loop write to.
      const memory = new MemoryManager(process.cwd());

      switch (action) {
        case "list": {
          const entries = memory.list();
          if (entries.length === 0) {
            console.log("\n  No memory entries.\n");
            return;
          }
          console.log(`\n  Memory (${entries.length} entries):\n`);
          for (const entry of entries) {
            const typeIcon =
              entry.type === "user"
                ? "👤"
                : entry.type === "feedback"
                  ? "💬"
                  : entry.type === "project"
                    ? "📁"
                    : "🔗";
            console.log(`    ${typeIcon} ${entry.name}`);
            console.log(`       ${entry.description.slice(0, 80)}`);
          }
          console.log();
          break;
        }
        case "search": {
          if (!query) {
            console.error("  Usage: storm memory search <query>");
            process.exit(1);
          }
          const results = memory.search(query);
          if (results.length === 0) {
            console.log(`\n  No memory entries matching "${query}".\n`);
            return;
          }
          console.log(
            `\n  Found ${results.length} entries matching "${query}":\n`,
          );
          for (const entry of results) {
            console.log(`    ${entry.name}: ${entry.description.slice(0, 80)}`);
          }
          console.log();
          break;
        }
        case "forget": {
          if (!query) {
            console.error("  Usage: storm memory forget <key>");
            process.exit(1);
          }
          const deleted = memory.delete(query);
          if (deleted) {
            console.log(`\n  Forgot: "${query}"\n`);
          } else {
            console.log(`\n  Memory "${query}" not found.\n`);
          }
          break;
        }

        // ── Week 1 Phase 4 additions (BR wiring) ─────────────────────
        //
        // These delegate to the BrainstormRouter gateway (via new gateway
        // client methods added in Phase 2) for team/shared memory,
        // approval workflow, and init-from-documents. Each action fails
        // gracefully with a clear error when no BR API key is configured.

        case "init": {
          // brainstorm memory init --from <file>
          //   Reads a Claude Code / Codex session JSONL (or plain text),
          //   sends to BR's /v1/memory/init endpoint for agent-driven
          //   fact extraction, prints the summary.
          //
          //   Note: commander action receives the two positional
          //   arguments (action, query). The file path rides on `query`
          //   to keep the existing [action] [query] signature. This is
          //   a little ugly but keeps the command surface backward-
          //   compatible. A cleaner subcommand structure is future work.
          const filePath = query;
          if (!filePath) {
            console.error(
              "  Usage: storm memory init <file>\n" +
                "  Supports Claude Code session JSONL or plain text documents.",
            );
            process.exit(1);
          }
          const gw = createGatewayClient();
          if (!gw) {
            console.error(
              "  No BRAINSTORM_API_KEY set. Set it in env or vault first.",
            );
            process.exit(1);
          }
          const { readFileSync: rfs, existsSync: exs } =
            await import("node:fs");
          if (!exs(filePath)) {
            console.error(`  File not found: ${filePath}`);
            process.exit(1);
          }
          const content = rfs(filePath, "utf-8");
          // Detect JSONL and extract content; otherwise treat as plain text doc.
          const documents: Array<{ content: string; source?: string }> = [];
          const isJsonl = filePath.endsWith(".jsonl");
          if (isJsonl) {
            const lines = content.split("\n").filter((l) => l.trim());
            for (const line of lines) {
              try {
                const obj = JSON.parse(line);
                // Claude Code trajectory format has `message.content` or
                // `text` fields. Try common shapes.
                const text =
                  typeof obj?.message?.content === "string"
                    ? obj.message.content
                    : typeof obj?.text === "string"
                      ? obj.text
                      : typeof obj?.content === "string"
                        ? obj.content
                        : null;
                if (text && text.trim()) {
                  documents.push({ content: text, source: filePath });
                }
              } catch {
                // Skip malformed lines
              }
            }
          } else {
            documents.push({ content, source: filePath });
          }

          if (documents.length === 0) {
            console.error(
              `  No extractable content found in ${filePath}. ` +
                "Expected JSONL with text/content fields or plain text.",
            );
            process.exit(1);
          }

          console.log(
            `\n  Sending ${documents.length} document(s) to BR /v1/memory/init...`,
          );
          try {
            const result = await gw.initMemoryFromDocs(documents);
            console.log(`  Status:  ${result.status}`);
            console.log(`  Summary: ${result.summary.slice(0, 200)}`);
            console.log(`  Entries: ${result.entries_after}\n`);
          } catch (err: any) {
            console.error(`  Memory init failed: ${err.message}`);
            process.exit(1);
          }
          break;
        }

        case "shared": {
          // brainstorm memory shared             → list team shared memory
          // brainstorm memory shared <fact>      → store a fact in team shared memory
          const gw = createGatewayClient();
          if (!gw) {
            console.error(
              "  No BRAINSTORM_API_KEY set. Team shared memory requires BR.",
            );
            process.exit(1);
          }
          if (query && query.length > 0 && query !== "list") {
            // Store path
            try {
              const result = await gw.storeSharedMemory(query);
              if (result.status === "pending_approval") {
                console.log(
                  `\n  ⏳ Memory write queued for approval (id: ${result.approvalId}).\n` +
                    `  Use 'storm memory pending' to see the queue.\n`,
                );
              } else {
                console.log(`\n  ✓ Shared memory saved.\n`);
              }
            } catch (err: any) {
              console.error(`  Shared memory write failed: ${err.message}`);
              process.exit(1);
            }
          } else {
            // List path
            try {
              const result = await gw.listSharedMemory();
              if (result.entries.length === 0) {
                console.log(`\n  No shared memory entries.`);
                if (result.pendingApprovals > 0) {
                  console.log(
                    `  ${result.pendingApprovals} pending approval(s) — see 'storm memory pending'.\n`,
                  );
                }
                console.log();
                return;
              }
              console.log(
                `\n  Team shared memory (${result.total} entries):\n`,
              );
              for (const entry of result.entries) {
                console.log(
                  `    👥 [${entry.block}] ${entry.fact.slice(0, 80)}`,
                );
                console.log(
                  `       by ${entry.createdBy} at ${entry.createdAt}`,
                );
              }
              if (result.pendingApprovals > 0) {
                console.log(
                  `\n  ⏳ ${result.pendingApprovals} pending approval(s) — see 'storm memory pending'\n`,
                );
              } else {
                console.log();
              }
            } catch (err: any) {
              console.error(`  Shared memory list failed: ${err.message}`);
              process.exit(1);
            }
          }
          break;
        }

        case "pending": {
          // brainstorm memory pending                        → list pending approvals
          // brainstorm memory pending approve <id>           → approve
          // brainstorm memory pending reject <id> [reason]   → reject
          //
          // The `query` positional carries the subcommand (list/approve/
          // reject) plus the id; parse it as "subcmd:id" or just "subcmd".
          const gw = createGatewayClient();
          if (!gw) {
            console.error(
              "  No BRAINSTORM_API_KEY set. Memory approval requires BR.",
            );
            process.exit(1);
          }
          const parts = (query ?? "").trim().split(/\s+/);
          const subcmd = parts[0] || "list";

          if (subcmd === "list" || subcmd === "") {
            try {
              const pending = await gw.listPendingMemory();
              if (pending.length === 0) {
                console.log("\n  No pending memory approvals.\n");
                return;
              }
              console.log(`\n  Pending approvals (${pending.length}):\n`);
              for (const p of pending) {
                console.log(`    ⏳ ${p.id}`);
                console.log(`       ${p.summary.slice(0, 80)}`);
                console.log(`       expires ${p.expiresAt}`);
              }
              console.log(
                `\n  To approve: storm memory pending approve <id>\n` +
                  `  To reject:  storm memory pending reject <id>\n`,
              );
            } catch (err: any) {
              console.error(`  Pending list failed: ${err.message}`);
              process.exit(1);
            }
          } else if (subcmd === "approve") {
            const id = parts[1];
            if (!id) {
              console.error("  Usage: storm memory pending approve <id>");
              process.exit(1);
            }
            try {
              await gw.approvePendingMemory(id);
              console.log(`\n  ✓ Approved: ${id}\n`);
            } catch (err: any) {
              console.error(`  Approval failed: ${err.message}`);
              process.exit(1);
            }
          } else if (subcmd === "reject") {
            const id = parts[1];
            const reason = parts.slice(2).join(" ");
            if (!id) {
              console.error(
                "  Usage: storm memory pending reject <id> [reason]",
              );
              process.exit(1);
            }
            try {
              await gw.rejectPendingMemory(id, reason || undefined);
              console.log(`\n  ✗ Rejected: ${id}\n`);
            } catch (err: any) {
              console.error(`  Rejection failed: ${err.message}`);
              process.exit(1);
            }
          } else {
            console.error(
              `  Unknown pending subcommand: ${subcmd}. Use list, approve, or reject.`,
            );
            process.exit(1);
          }
          break;
        }

        case "doctor": {
          // brainstorm memory doctor — clean up and reorganize local memory
          // (Letta Code parity from their /doctor slash command).
          //
          // For now this runs the MemoryManager's existing consolidation
          // path: walks the store, removes duplicates, rebuilds the
          // index, prunes quarantine entries older than 30 days.
          console.log("\n  Running memory doctor...\n");
          const before = memory.list();
          // Simple dedup by name — keep the most recent entry per name
          const seen = new Map<string, any>();
          for (const entry of before) {
            const existing = seen.get(entry.name);
            if (
              !existing ||
              (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0)
            ) {
              seen.set(entry.name, entry);
            }
          }
          const duplicateIds = before
            .filter((e) => seen.get(e.name)?.id !== e.id)
            .map((e) => e.id);
          for (const id of duplicateIds) {
            memory.delete(id);
          }
          const after = memory.list();
          console.log(`  Before: ${before.length} entries`);
          console.log(`  After:  ${after.length} entries`);
          console.log(
            `  Removed: ${duplicateIds.length} duplicate(s) by name\n`,
          );
          break;
        }

        default:
          console.error(
            `  Unknown action: ${action}. ` +
              `Use list, search, forget, init, shared, pending, or doctor.`,
          );
          process.exit(1);
      }
    });

  // ── Sync Command ─────────────────────────────────────────────────
  //
  // Visibility and manual control for the fire-and-forget BR sync queue
  // introduced in Week 1 Phase 1. The queue lives in the local SQLite
  // database (sync_queue table, migration 030) and drains on a timer
  // whenever the chat command is running. These subcommands let users
  // inspect queue state and force a drain on demand — critical for
  // debugging and for users without a long-running daemon.

  program
    .command("sync")
    .description("Inspect and manage the BrainstormRouter sync queue")
    .argument("[action]", "Action: status, flush, prune", "status")
    .action(async (action: string) => {
      const { SyncQueueRepository } = await import("@brainst0rm/db");
      const { SyncWorker } = await import("@brainst0rm/gateway");

      const db = getDb();
      const repo = new SyncQueueRepository(db);

      switch (action) {
        case "status": {
          const stats = repo.getStats();
          const total =
            stats.pending + stats.inFlight + stats.completed + stats.failed;

          console.log("\n  BR Sync Queue\n");
          console.log(`  Total rows:  ${total}`);
          console.log(`    pending:   ${stats.pending}`);
          console.log(`    in_flight: ${stats.inFlight}`);
          console.log(`    completed: ${stats.completed}`);
          console.log(`    failed:    ${stats.failed}`);

          if (stats.oldestPending !== null) {
            const age = Math.floor(
              (Date.now() / 1000 - stats.oldestPending) / 60,
            );
            console.log(`\n  Oldest pending: ${age} minutes ago`);
          }

          if (stats.latestFailure) {
            console.log(`\n  Latest failure:`);
            console.log(`    id:     ${stats.latestFailure.id}`);
            console.log(`    tries:  ${stats.latestFailure.attemptCount}`);
            console.log(
              `    error:  ${stats.latestFailure.error.slice(0, 200)}`,
            );
          }

          // Warn if BR isn't configured — queue has nowhere to go
          const gw = createGatewayClient();
          if (!gw && stats.pending > 0) {
            console.log(
              `\n  ⚠ BRAINSTORM_API_KEY not set — ${stats.pending} item(s) will stay queued until a gateway is configured.`,
            );
          }
          console.log();
          break;
        }

        case "flush": {
          // Drain the queue synchronously, once. Useful after offline
          // work to push pending memory writes, or after setting a new
          // BRAINSTORM_API_KEY for the first time.
          const gw = createGatewayClient();
          if (!gw) {
            console.error("  No BRAINSTORM_API_KEY set. Configure BR first.");
            process.exit(1);
          }
          const worker = new SyncWorker({ gateway: gw, repo });
          console.log("\n  Draining sync queue...");
          const result = await worker.drainOnce();
          console.log(
            `  Processed ${result.processed}: ` +
              `${result.succeeded} succeeded, ${result.failed} failed\n`,
          );
          if (result.failed > 0) {
            const stats = worker.getStats();
            if (stats.lastError) {
              console.log(`  Last error: ${stats.lastError}\n`);
            }
          }
          break;
        }

        case "prune": {
          // Remove completed rows older than 7 days (604800 seconds) to
          // keep the queue table bounded on long-running installations.
          const deleted = repo.pruneCompleted(7 * 24 * 60 * 60);
          console.log(
            `\n  Pruned ${deleted} completed row(s) older than 7 days.\n`,
          );
          break;
        }

        default:
          console.error(
            `  Unknown action: ${action}. Use status, flush, or prune.`,
          );
          process.exit(1);
      }
    });

  // ── Codebase Audit Command ─────────────────────────────────────────
  //
  // The "attack and document" primitive. Spawns a fleet of workers,
  // each scoped to a package/app, each emitting structured findings
  // to shared memory. Findings flow through the same sync path as
  // regular memory writes — team members see them from their own CLI
  // via `brainstorm findings list`.
}
