/**
 * TriggerRunner — finds due scheduled tasks and executes them.
 *
 * Called by: `storm schedule run` (CLI) or external cron job.
 * Checks all active tasks, runs those that are due, respects concurrency limits.
 */

import type Database from "better-sqlite3";
import { ScheduledTaskRepository, TaskRunRepository } from "./repository.js";
import { isDue } from "./cron-parser.js";
import { validateTaskSafety } from "./safety.js";
import type { ScheduledTask, ScheduledTaskRun } from "@brainst0rm/shared";

export interface TriggerResult {
  tasksChecked: number;
  tasksRun: number;
  tasksFailed: number;
  tasksSkipped: number;
  runs: Array<{
    taskName: string;
    runId: string;
    status: string;
    cost: number;
    error?: string;
  }>;
}

/** Callback for daemon-integrated execution. */
export type DaemonExecutor = (
  task: ScheduledTask,
  run: ScheduledTaskRun,
) => Promise<{ outputSummary: string; cost: number; turnsUsed: number }>;

export class TriggerRunner {
  private tasks: ScheduledTaskRepository;
  private runs: TaskRunRepository;
  private maxConcurrent: number;
  private executor: DaemonExecutor | null = null;

  constructor(
    private db: Database.Database,
    opts?: { maxConcurrent?: number },
  ) {
    this.tasks = new ScheduledTaskRepository(db);
    this.runs = new TaskRunRepository(db);
    this.maxConcurrent = opts?.maxConcurrent ?? 3;

    // Zombie sweep on startup: a previous process may have crashed mid-run
    // and left rows stuck in status='running'. Without this, each such row
    // would count toward the concurrency limit forever, eventually wedging
    // the scheduler so no new tasks could dispatch.
    const swept = this.runs.sweepZombieRunning();
    if (swept.length > 0) {
      console.error(
        `[scheduler] swept ${swept.length} zombie run(s) from a prior crash: ${swept.join(", ")}`,
      );
    }
  }

  /**
   * Connect a daemon executor. When set, tasks are executed via the daemon
   * controller's agent loop instead of the placeholder stub.
   */
  setExecutor(executor: DaemonExecutor): void {
    this.executor = executor;
  }

  /** Get summaries of due tasks (for tick message injection). */
  getDueTaskSummaries(): string[] {
    this.tasks.expireStale();
    const active = this.tasks.list(undefined, "active");
    const due: string[] = [];

    for (const task of active) {
      if (!task.cronExpression) {
        const lastRun = this.runs.getLastRun(task.id);
        if (!lastRun)
          due.push(`[one-shot] ${task.name}: ${task.prompt.slice(0, 80)}`);
        continue;
      }
      const lastRun = this.runs.getLastRun(task.id);
      if (isDue(task.cronExpression, lastRun?.createdAt ?? null)) {
        due.push(
          `[${task.cronExpression}] ${task.name}: ${task.prompt.slice(0, 80)}`,
        );
      }
    }

    return due;
  }

  /**
   * Find and execute all due tasks.
   * Returns a summary of what was run.
   */
  async runDueTasks(opts?: {
    taskId?: string;
    dryRun?: boolean;
  }): Promise<TriggerResult> {
    // Expire stale tasks first
    this.tasks.expireStale();

    // Get active tasks
    const activeTasks = opts?.taskId
      ? ([this.tasks.getById(opts.taskId)].filter(Boolean) as ScheduledTask[])
      : this.tasks.list(undefined, "active");

    const result: TriggerResult = {
      tasksChecked: activeTasks.length,
      tasksRun: 0,
      tasksFailed: 0,
      tasksSkipped: 0,
      runs: [],
    };

    // Check which are due
    const dueTasks: ScheduledTask[] = [];
    for (const task of activeTasks) {
      if (opts?.taskId) {
        // Manual trigger — always run
        dueTasks.push(task);
        continue;
      }

      if (!task.cronExpression) {
        // One-shot task — only run if never run before
        const lastRun = this.runs.getLastRun(task.id);
        if (!lastRun) dueTasks.push(task);
        continue;
      }

      const lastRun = this.runs.getLastRun(task.id);
      if (isDue(task.cronExpression, lastRun?.createdAt ?? null)) {
        dueTasks.push(task);
      }
    }

    if (dueTasks.length === 0) {
      return result;
    }

    // Respect concurrency limit. Query the exact running count via
    // the repository — `listRecent(maxConcurrent * 2).filter(running)`
    // could undercount when running rows fell outside the N-most-
    // recent window (e.g., long-lived zombie runs that hadn't been
    // swept yet). countRunning is an index-backed COUNT, so it's
    // cheap AND authoritative.
    const currentlyRunning = this.runs.countRunning();

    const available = Math.max(0, this.maxConcurrent - currentlyRunning);
    const toRun = dueTasks.slice(0, available);
    result.tasksSkipped = dueTasks.length - toRun.length;

    // Execute each task
    for (const task of toRun) {
      if (opts?.dryRun) {
        const warnings = validateTaskSafety(task);
        result.runs.push({
          taskName: task.name,
          runId: "dry-run",
          status:
            warnings.length > 0
              ? `warnings: ${warnings.join("; ")}`
              : "would-run",
          cost: 0,
        });
        result.tasksRun++;
        continue;
      }

      // Create run record
      const run = this.runs.create({
        taskId: task.id,
        triggerType: opts?.taskId ? "manual" : "cron",
      });

      try {
        // Mark as running (without stamping completed_at — see markRunning).
        this.runs.markRunning(run.id);

        if (this.executor) {
          // Execute via daemon controller's agent loop
          const execResult = await this.executor(task, run);
          this.runs.complete(run.id, {
            status: "completed",
            outputSummary: execResult.outputSummary,
            cost: execResult.cost,
            turnsUsed: execResult.turnsUsed,
          });

          result.tasksRun++;
          result.runs.push({
            taskName: task.name,
            runId: run.id,
            status: "completed",
            cost: execResult.cost,
          });
        } else {
          // No executor connected — mark as failed
          this.runs.complete(run.id, {
            status: "failed",
            outputSummary:
              "Execution engine not connected. Use --daemon mode or setExecutor().",
            cost: 0,
            turnsUsed: 0,
            error: "AGENT_LOOP_NOT_CONNECTED",
          });

          result.tasksRun++;
          result.runs.push({
            taskName: task.name,
            runId: run.id,
            status: "failed",
            cost: 0,
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.runs.complete(run.id, {
          status: "failed",
          cost: 0,
          turnsUsed: 0,
          error,
        });
        result.tasksFailed++;
        result.runs.push({
          taskName: task.name,
          runId: run.id,
          status: "failed",
          cost: 0,
          error,
        });
      }
    }

    return result;
  }
}
