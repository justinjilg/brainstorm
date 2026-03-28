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
} from "@brainstorm/shared";

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
}
