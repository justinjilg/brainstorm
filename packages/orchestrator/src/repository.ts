/**
 * Repositories for orchestration_runs and orchestration_tasks tables.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  OrchestrationRun,
  OrchestrationStatus,
  OrchestrationTask,
  OrchTaskStatus,
} from "@brainst0rm/shared";

function rowToRun(row: any): OrchestrationRun {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    leadSessionId: row.lead_session_id ?? undefined,
    status: row.status as OrchestrationStatus,
    projectIds: JSON.parse(row.project_ids || "[]"),
    budgetLimit: row.budget_limit ?? undefined,
    totalCost: row.total_cost,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTask(row: any): OrchestrationTask {
  return {
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    prompt: row.prompt,
    status: row.status as OrchTaskStatus,
    subagentType: row.subagent_type,
    resultSummary: row.result_summary ?? undefined,
    cost: row.cost,
    sessionId: row.session_id ?? undefined,
    dependsOn: JSON.parse(row.depends_on || "[]"),
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    // Worker-pool fields added in migration 029. Backward compatible —
    // older databases without these columns return undefined for all four.
    assignedWorker: row.assigned_worker ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    filesTouched: row.files_touched ? JSON.parse(row.files_touched) : undefined,
    error: row.error ?? undefined,
  };
}

export class OrchestrationRunRepository {
  constructor(private db: Database.Database) {}

  create(data: {
    name: string;
    description: string;
    projectIds: string[];
    budgetLimit?: number;
    leadSessionId?: string;
  }): OrchestrationRun {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO orchestration_runs (id, name, description, lead_session_id, project_ids, budget_limit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.name,
        data.description,
        data.leadSessionId ?? null,
        JSON.stringify(data.projectIds),
        data.budgetLimit ?? null,
        now,
        now,
      );
    return this.getById(id)!;
  }

  getById(id: string): OrchestrationRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM orchestration_runs WHERE id = ?")
      .get(id);
    return row ? rowToRun(row) : undefined;
  }

  listRecent(limit = 10): OrchestrationRun[] {
    return this.db
      .prepare(
        "SELECT * FROM orchestration_runs ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map(rowToRun);
  }

  updateStatus(id: string, status: OrchestrationStatus, cost?: number): void {
    const now = Math.floor(Date.now() / 1000);
    if (cost !== undefined) {
      this.db
        .prepare(
          "UPDATE orchestration_runs SET status = ?, total_cost = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, cost, now, id);
    } else {
      this.db
        .prepare(
          "UPDATE orchestration_runs SET status = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, now, id);
    }
  }
}

export class OrchestrationTaskRepository {
  constructor(private db: Database.Database) {}

  create(data: {
    runId: string;
    projectId: string;
    prompt: string;
    subagentType?: string;
    dependsOn?: string[];
  }): OrchestrationTask {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO orchestration_tasks (id, run_id, project_id, prompt, subagent_type, depends_on)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.runId,
        data.projectId,
        data.prompt,
        data.subagentType ?? "code",
        JSON.stringify(data.dependsOn ?? []),
      );
    return this.getById(id)!;
  }

  getById(id: string): OrchestrationTask | undefined {
    const row = this.db
      .prepare("SELECT * FROM orchestration_tasks WHERE id = ?")
      .get(id);
    return row ? rowToTask(row) : undefined;
  }

  listByRun(runId: string): OrchestrationTask[] {
    return this.db
      .prepare("SELECT * FROM orchestration_tasks WHERE run_id = ?")
      .all(runId)
      .map(rowToTask);
  }

  updateStatus(
    id: string,
    status: OrchTaskStatus,
    data?: { resultSummary?: string; cost?: number; sessionId?: string },
  ): void {
    const now = Math.floor(Date.now() / 1000);
    const completedAt =
      status === "completed" || status === "failed" ? now : null;
    const startedAt = status === "running" ? now : undefined;

    this.db
      .prepare(
        `UPDATE orchestration_tasks SET status = ?, result_summary = COALESCE(?, result_summary),
         cost = COALESCE(?, cost), session_id = COALESCE(?, session_id),
         started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at)
         WHERE id = ?`,
      )
      .run(
        status,
        data?.resultSummary ?? null,
        data?.cost ?? null,
        data?.sessionId ?? null,
        startedAt ?? null,
        completedAt,
        id,
      );
  }

  /**
   * Atomically claim a pending task whose dependencies are all completed.
   * Returns the claimed task or undefined if nothing is claimable right now.
   *
   * The Planner/Worker/Judge pattern relies on this for safe concurrent
   * worker access to a shared task board. SQLite's single-writer model +
   * the WHERE status='pending' filter on the UPDATE makes the claim atomic
   * within a single process. Cross-process claims would need explicit
   * row locking — out of scope for the MVP.
   */
  claimNext(runId: string, workerId: string): OrchestrationTask | undefined {
    const pendingRows = this.db
      .prepare(
        "SELECT * FROM orchestration_tasks WHERE run_id = ? AND status = 'pending'",
      )
      .all(runId) as any[];
    if (pendingRows.length === 0) return undefined;

    const completedIds = new Set(
      (
        this.db
          .prepare(
            "SELECT id FROM orchestration_tasks WHERE run_id = ? AND status = 'completed'",
          )
          .all(runId) as any[]
      ).map((r) => r.id),
    );

    for (const row of pendingRows) {
      const deps = JSON.parse(row.depends_on || "[]") as string[];
      if (!deps.every((d) => completedIds.has(d))) continue;

      const result = this.db
        .prepare(
          `UPDATE orchestration_tasks
           SET status = 'in_progress',
               assigned_worker = ?,
               started_at = unixepoch()
           WHERE id = ? AND status = 'pending'`,
        )
        .run(workerId, row.id);
      if (result.changes === 1) {
        return this.getById(row.id);
      }
      // Lost the race — try the next pending task.
    }
    return undefined;
  }

  /**
   * Mark a task completed with worker-pool metadata (worktree path, files
   * touched). Used by the Worker after the agent finishes successfully.
   */
  completeWithMetadata(
    id: string,
    data: {
      resultSummary?: string;
      cost?: number;
      sessionId?: string;
      worktreePath?: string;
      filesTouched?: string[];
    },
  ): void {
    this.db
      .prepare(
        `UPDATE orchestration_tasks
         SET status = 'completed',
             result_summary = COALESCE(?, result_summary),
             cost = COALESCE(?, cost),
             session_id = COALESCE(?, session_id),
             worktree_path = COALESCE(?, worktree_path),
             files_touched = COALESCE(?, files_touched),
             completed_at = unixepoch()
         WHERE id = ?`,
      )
      .run(
        data.resultSummary ?? null,
        data.cost ?? null,
        data.sessionId ?? null,
        data.worktreePath ?? null,
        data.filesTouched ? JSON.stringify(data.filesTouched) : null,
        id,
      );
  }

  /** Mark a task as failed with an error message. */
  failTask(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE orchestration_tasks
         SET status = 'failed', error = ?, completed_at = unixepoch()
         WHERE id = ?`,
      )
      .run(error, id);
  }

  /**
   * True when every task in the run has reached a terminal state
   * (completed, failed, or skipped). Used by the orchestrator to know
   * when the Judge phase should run.
   */
  allTasksFinished(runId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS open
         FROM orchestration_tasks
         WHERE run_id = ? AND status IN ('pending', 'in_progress', 'running')`,
      )
      .get(runId) as { open: number };
    return (row?.open ?? 0) === 0;
  }
}
