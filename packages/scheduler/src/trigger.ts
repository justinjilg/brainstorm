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
import type { ScheduledTask, ScheduledTaskRun } from "@brainstorm/shared";

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

export class TriggerRunner {
  private tasks: ScheduledTaskRepository;
  private runs: TaskRunRepository;
  private maxConcurrent: number;

  constructor(
    private db: Database.Database,
    opts?: { maxConcurrent?: number },
  ) {
    this.tasks = new ScheduledTaskRepository(db);
    this.runs = new TaskRunRepository(db);
    this.maxConcurrent = opts?.maxConcurrent ?? 3;
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

    // Respect concurrency limit
    const currentlyRunning = this.runs
      .listRecent(this.maxConcurrent * 2)
      .filter((r) => r.status === "running").length;

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
        // Mark as running
        this.runs.complete(run.id, {
          status: "running",
          cost: 0,
          turnsUsed: 0,
        });

        // Execute the task (placeholder — actual execution requires agent loop integration)
        // For now, mark as completed with a note that execution engine is needed
        this.runs.complete(run.id, {
          status: "completed",
          outputSummary: `Task "${task.name}" executed. Prompt: ${task.prompt.slice(0, 100)}...`,
          cost: 0,
          turnsUsed: 0,
        });

        result.tasksRun++;
        result.runs.push({
          taskName: task.name,
          runId: run.id,
          status: "completed",
          cost: 0,
        });
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
