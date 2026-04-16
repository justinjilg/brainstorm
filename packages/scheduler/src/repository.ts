/**
 * Repository for scheduled_tasks and scheduled_task_runs tables.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskStatus,
  TaskRunStatus,
  ExecutionMode,
  TriggerType,
} from "@brainst0rm/shared";

function rowToTask(row: any): ScheduledTask {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prompt: row.prompt,
    cronExpression: row.cron_expression ?? undefined,
    executionMode: row.execution_mode as ExecutionMode,
    allowMutations: Boolean(row.allow_mutations),
    budgetLimit: row.budget_limit ?? undefined,
    maxTurns: row.max_turns,
    timeoutMs: row.timeout_ms,
    modelId: row.model_id ?? undefined,
    status: row.status as ScheduledTaskStatus,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: any): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id ?? undefined,
    status: row.status as TaskRunStatus,
    triggerType: row.trigger_type as TriggerType,
    outputSummary: row.output_summary ?? undefined,
    cost: row.cost,
    turnsUsed: row.turns_used,
    error: row.error ?? undefined,
    trajectoryPath: row.trajectory_path ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
  };
}

export class ScheduledTaskRepository {
  constructor(private db: Database.Database) {}

  list(projectId?: string, status?: ScheduledTaskStatus): ScheduledTask[] {
    let sql = "SELECT * FROM scheduled_tasks";
    const conditions: string[] = [];
    const params: any[] = [];

    if (projectId) {
      conditions.push("project_id = ?");
      params.push(projectId);
    }
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY name";

    return this.db
      .prepare(sql)
      .all(...params)
      .map(rowToTask);
  }

  getById(id: string): ScheduledTask | undefined {
    const row = this.db
      .prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
      .get(id);
    return row ? rowToTask(row) : undefined;
  }

  create(data: {
    projectId: string;
    name: string;
    prompt: string;
    cronExpression?: string;
    executionMode?: ExecutionMode;
    allowMutations?: boolean;
    budgetLimit?: number;
    maxTurns?: number;
    timeoutMs?: number;
    modelId?: string;
    expiresAt?: number;
  }): ScheduledTask {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (id, project_id, name, prompt, cron_expression, execution_mode,
         allow_mutations, budget_limit, max_turns, timeout_ms, model_id, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.projectId,
        data.name,
        data.prompt,
        data.cronExpression ?? null,
        data.executionMode ?? "trigger",
        data.allowMutations ? 1 : 0,
        data.budgetLimit ?? null,
        data.maxTurns ?? 20,
        data.timeoutMs ?? 600000,
        data.modelId ?? null,
        data.expiresAt ?? null,
        now,
        now,
      );

    return this.getById(id)!;
  }

  updateStatus(id: string, status: ScheduledTaskStatus): void {
    this.db
      .prepare(
        "UPDATE scheduled_tasks SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, Math.floor(Date.now() / 1000), id);
  }

  delete(id: string): void {
    this.updateStatus(id, "deleted");
  }

  /** Expire tasks past their expires_at timestamp. */
  expireStale(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(
        "UPDATE scheduled_tasks SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?",
      )
      .run(now, now);
    return result.changes;
  }
}

export class TaskRunRepository {
  constructor(private db: Database.Database) {}

  listByTask(taskId: string, limit = 10): ScheduledTaskRun[] {
    return this.db
      .prepare(
        "SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(taskId, limit)
      .map(rowToRun);
  }

  listRecent(limit = 20): ScheduledTaskRun[] {
    return this.db
      .prepare(
        "SELECT * FROM scheduled_task_runs ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map(rowToRun);
  }

  getById(id: string): ScheduledTaskRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM scheduled_task_runs WHERE id = ?")
      .get(id);
    return row ? rowToRun(row) : undefined;
  }

  create(data: {
    taskId: string;
    triggerType: TriggerType;
    sessionId?: string;
  }): ScheduledTaskRun {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `INSERT INTO scheduled_task_runs (id, task_id, session_id, trigger_type, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, data.taskId, data.sessionId ?? null, data.triggerType, now, now);

    return this.getById(id)!;
  }

  complete(
    id: string,
    data: {
      status: TaskRunStatus;
      outputSummary?: string;
      cost: number;
      turnsUsed: number;
      error?: string;
      trajectoryPath?: string;
    },
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE scheduled_task_runs SET status = ?, output_summary = ?, cost = ?,
         turns_used = ?, error = ?, trajectory_path = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        data.status,
        data.outputSummary ?? null,
        data.cost,
        data.turnsUsed,
        data.error ?? null,
        data.trajectoryPath ?? null,
        now,
        id,
      );
  }

  /**
   * Mark an in-flight run as "running" without stamping completed_at.
   *
   * The scheduler used to reuse complete() for this transition, which set
   * completed_at to the current time even though the run hadn't finished.
   * That broke "in-flight" queries keyed on completed_at IS NULL, and any
   * caller inspecting elapsed time would see "ran for 0ms" on still-running
   * rows.
   */
  markRunning(id: string): void {
    this.db
      .prepare(`UPDATE scheduled_task_runs SET status = 'running' WHERE id = ?`)
      .run(id);
  }

  /**
   * Sweep rows stuck in status='running' from a previous process crash.
   * Updates them to 'crashed' with the current timestamp so observers see
   * a real completed_at, and returns the ids that were swept.
   */
  sweepZombieRunning(): string[] {
    const now = Math.floor(Date.now() / 1000);
    const rows = this.db
      .prepare(`SELECT id FROM scheduled_task_runs WHERE status = 'running'`)
      .all() as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE scheduled_task_runs
         SET status = 'crashed',
             completed_at = ?,
             error = COALESCE(error, 'Process crashed while running')
         WHERE id IN (${placeholders})`,
      )
      .run(now, ...ids);
    return ids;
  }

  /** Get the most recent run for a task (to determine last execution time). */
  getLastRun(taskId: string): ScheduledTaskRun | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId);
    return row ? rowToRun(row) : undefined;
  }
}
