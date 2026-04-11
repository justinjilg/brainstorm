/**
 * Multi-Agent Worker Pool — runs N concurrent workers that pull from the
 * persistent task board and execute each task in an isolated git worktree.
 *
 * Part of Transformation 2 from linked-crunching-hamming.md.
 *
 * Each worker:
 *   1. Calls taskRepo.claimNext() to atomically grab a pending task whose
 *      dependencies are all completed.
 *   2. Creates a fresh git worktree via createWorktree() so its file edits
 *      don't conflict with other workers.
 *   3. Spawns a subagent with the task prompt, scoped to the worktree.
 *   4. On success: captures git diff, lists files touched, marks completed
 *      with metadata. On failure: marks failed with error message.
 *   5. Loops until claimNext returns undefined (no work, may need to wait
 *      for other workers' dependencies to complete) or the run is finished.
 *
 * The pool emits events for each state transition so the CLI / UI can
 * render progress in real time. The whole loop runs until allTasksFinished
 * is true OR every worker has stalled with nothing to claim.
 */

import { OrchestrationTaskRepository } from "@brainst0rm/orchestrator";
import type {
  OrchestrationStatus,
  OrchestrationTask,
} from "@brainst0rm/shared";
import { createLogger } from "@brainst0rm/shared";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createWorktree, removeWorktree } from "../agent/speculative.js";
import { spawnSubagent, type SubagentOptions } from "../agent/subagent.js";
import type { SubagentType } from "../agent/subagent.js";

const log = createLogger("multi-agent-worker-pool");

export interface WorkerPoolEvent {
  type:
    | "pool-started"
    | "worker-claimed"
    | "worker-completed"
    | "worker-failed"
    | "worker-idle"
    | "pool-finished";
  workerId?: string;
  task?: OrchestrationTask;
  cost?: number;
  filesTouched?: string[];
  error?: string;
  totalCompleted?: number;
  totalFailed?: number;
}

export interface WorkerPoolOptions {
  /** Run id from the Planner. */
  runId: string;
  /** SQLite handle. */
  db: Database.Database;
  /** Subagent options template — each worker spawns with these as defaults. */
  subagentOptions: SubagentOptions;
  /** Max concurrent workers. Default 3. */
  concurrency?: number;
  /** Max time the pool will run before forcefully stopping (ms). Default 30 min. */
  timeoutMs?: number;
  /** When true, leave worktrees on disk after the pool finishes — useful for
   * the Judge to inspect them. Default true (Judge needs them). */
  preserveWorktrees?: boolean;
}

export interface WorkerPoolResult {
  runId: string;
  status: OrchestrationStatus;
  totalCompleted: number;
  totalFailed: number;
  totalCost: number;
  durationMs: number;
  worktrees: string[];
}

/**
 * Run the worker pool until all tasks finish or timeout.
 * Yields events for each state transition.
 */
export async function* runWorkerPool(
  options: WorkerPoolOptions,
): AsyncGenerator<WorkerPoolEvent, WorkerPoolResult> {
  const {
    runId,
    db,
    subagentOptions,
    concurrency = 3,
    timeoutMs = 30 * 60 * 1000,
    preserveWorktrees = true,
  } = options;
  const startedAt = Date.now();
  const taskRepo = new OrchestrationTaskRepository(db);
  const projectPath = subagentOptions.projectPath;

  let totalCompleted = 0;
  let totalFailed = 0;
  let totalCost = 0;
  const worktrees: string[] = [];

  yield { type: "pool-started" };

  // Each worker is an async loop that claims and runs tasks until the
  // queue is empty. We start `concurrency` of them and use a shared event
  // queue so the generator can yield events from any worker as they happen.
  const eventQueue: WorkerPoolEvent[] = [];
  let resolveNext: (() => void) | null = null;
  const pushEvent = (e: WorkerPoolEvent) => {
    eventQueue.push(e);
    if (resolveNext) {
      resolveNext();
      resolveNext = null;
    }
  };

  let activeWorkers = 0;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    log.warn({ timeoutMs }, "Worker pool timed out");
  }, timeoutMs);

  // Worker loop: claim, execute, complete, repeat. Returns when there's
  // nothing left to claim AND the run is finished, OR on timeout.
  const workerLoop = async (workerId: string): Promise<void> => {
    activeWorkers++;
    try {
      while (!timedOut) {
        const claimed = taskRepo.claimNext(runId, workerId);
        if (!claimed) {
          // No claimable task right now. If the run is finished, exit.
          // Otherwise yield idle and wait briefly — another worker may
          // complete a dependency and unblock our queue.
          if (taskRepo.allTasksFinished(runId)) {
            return;
          }
          pushEvent({ type: "worker-idle", workerId });
          await sleep(500);
          continue;
        }

        pushEvent({ type: "worker-claimed", workerId, task: claimed });

        // Create an isolated worktree for this task. createWorktree throws
        // on git errors — convert to a task failure rather than crashing
        // the pool.
        let worktreePath: string;
        try {
          worktreePath = createWorktree(
            projectPath,
            `task-${claimed.id.slice(0, 8)}`,
          );
          worktrees.push(worktreePath);
        } catch (err: any) {
          taskRepo.failTask(
            claimed.id,
            `worktree creation failed: ${err.message}`,
          );
          totalFailed++;
          pushEvent({
            type: "worker-failed",
            workerId,
            task: claimed,
            error: err.message,
          });
          continue;
        }

        // Spawn the subagent against the worktree (NOT the project root).
        try {
          const result = await spawnSubagent(claimed.prompt, {
            ...subagentOptions,
            projectPath: worktreePath,
            type: claimed.subagentType as SubagentType,
          });

          if (result.budgetExceeded) {
            taskRepo.failTask(
              claimed.id,
              `budget exceeded mid-task ($${result.cost.toFixed(4)} used)`,
            );
            totalFailed++;
            totalCost += result.cost;
            pushEvent({
              type: "worker-failed",
              workerId,
              task: claimed,
              error: "budget-exceeded",
              cost: result.cost,
            });
            continue;
          }

          // Capture what the agent actually changed.
          const filesTouched = listFilesTouched(worktreePath);

          taskRepo.completeWithMetadata(claimed.id, {
            resultSummary: result.text.slice(0, 1000),
            cost: result.cost,
            worktreePath,
            filesTouched,
          });
          totalCompleted++;
          totalCost += result.cost;
          pushEvent({
            type: "worker-completed",
            workerId,
            task: claimed,
            cost: result.cost,
            filesTouched,
          });
        } catch (err: any) {
          taskRepo.failTask(claimed.id, err.message ?? String(err));
          totalFailed++;
          pushEvent({
            type: "worker-failed",
            workerId,
            task: claimed,
            error: err.message ?? String(err),
          });
        }
      }
    } finally {
      activeWorkers--;
      if (activeWorkers === 0 && resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    }
  };

  // Spawn the workers. They run in parallel; we don't await them here —
  // we await the event-queue draining instead so the generator can yield
  // events as they happen.
  const workers = Array.from({ length: concurrency }, (_, i) =>
    workerLoop(`worker-${i + 1}`),
  );

  // Drain the event queue. When activeWorkers == 0 and the queue is empty,
  // the pool is done.
  while (true) {
    if (eventQueue.length > 0) {
      yield eventQueue.shift()!;
      continue;
    }
    if (activeWorkers === 0) break;
    await new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
  }

  // Make sure all workers finish before we return — the loop above can exit
  // as soon as the queue drains, but we want to await any in-flight cleanup.
  await Promise.allSettled(workers);
  clearTimeout(timeoutHandle);

  // Cleanup worktrees if not preserving for the Judge.
  if (!preserveWorktrees) {
    for (const wt of worktrees) {
      try {
        removeWorktree(projectPath, wt);
      } catch {
        // Best effort
      }
    }
  }

  let status: OrchestrationStatus;
  if (timedOut) {
    status = "failed";
  } else if (totalFailed === 0) {
    status = "completed";
  } else if (totalCompleted > 0) {
    status = "partial";
  } else {
    status = "failed";
  }

  yield { type: "pool-finished", totalCompleted, totalFailed };

  return {
    runId,
    status,
    totalCompleted,
    totalFailed,
    totalCost,
    durationMs: Date.now() - startedAt,
    worktrees,
  };
}

/**
 * List the files modified by a task in its worktree. Uses git status to
 * detect both staged and unstaged changes plus untracked files.
 *
 * Exported for testing — the porcelain parser is the trickiest pure
 * piece of the worker pool and benefits from explicit coverage.
 */
export function listFilesTouched(worktreePath: string): string[] {
  try {
    // -uall: list every untracked FILE, not collapsed directories. Without
    // it, "src/deep/file.ts" gets folded into "src/" and the Judge can't
    // detect cross-worker conflicts at file granularity.
    const out = execFileSync("git", ["status", "--porcelain", "-uall"], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // Porcelain format: "XY filename" — we want the filename (after status flags)
        return line.replace(/^[\sA-Z?!]{1,2}\s+/, "");
      });
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
