/**
 * ProjectRepository — CRUD for the projects and project_memory tables.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Project, ProjectMemoryEntry } from "@brainst0rm/shared";

function rowToProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    description: row.description,
    customInstructions: row.custom_instructions ?? undefined,
    knowledgeFiles: JSON.parse(row.knowledge_files || "[]"),
    budgetDaily: row.budget_daily ?? undefined,
    budgetMonthly: row.budget_monthly ?? undefined,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  constructor(private db: Database.Database) {}

  list(includeInactive = false): Project[] {
    const sql = includeInactive
      ? "SELECT * FROM projects ORDER BY name"
      : "SELECT * FROM projects WHERE is_active = 1 ORDER BY name";
    return this.db.prepare(sql).all().map(rowToProject);
  }

  getById(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? rowToProject(row) : undefined;
  }

  getByName(name: string): Project | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE name = ? AND is_active = 1")
      .get(name);
    return row ? rowToProject(row) : undefined;
  }

  getByPath(path: string): Project | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE path = ? AND is_active = 1")
      .get(path);
    return row ? rowToProject(row) : undefined;
  }

  create(data: {
    name: string;
    path: string;
    description?: string;
    customInstructions?: string;
    knowledgeFiles?: string[];
    budgetDaily?: number;
    budgetMonthly?: number;
  }): Project {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, description, custom_instructions, knowledge_files, budget_daily, budget_monthly, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.name,
        data.path,
        data.description ?? "",
        data.customInstructions ?? null,
        JSON.stringify(data.knowledgeFiles ?? []),
        data.budgetDaily ?? null,
        data.budgetMonthly ?? null,
        now,
        now,
      );

    return this.getById(id)!;
  }

  update(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      customInstructions: string | null;
      knowledgeFiles: string[];
      budgetDaily: number | null;
      budgetMonthly: number | null;
      isActive: boolean;
    }>,
  ): Project | undefined {
    const sets: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) {
      sets.push("name = ?");
      values.push(data.name);
    }
    if (data.description !== undefined) {
      sets.push("description = ?");
      values.push(data.description);
    }
    if (data.customInstructions !== undefined) {
      sets.push("custom_instructions = ?");
      values.push(data.customInstructions);
    }
    if (data.knowledgeFiles !== undefined) {
      sets.push("knowledge_files = ?");
      values.push(JSON.stringify(data.knowledgeFiles));
    }
    if (data.budgetDaily !== undefined) {
      sets.push("budget_daily = ?");
      values.push(data.budgetDaily);
    }
    if (data.budgetMonthly !== undefined) {
      sets.push("budget_monthly = ?");
      values.push(data.budgetMonthly);
    }
    if (data.isActive !== undefined) {
      sets.push("is_active = ?");
      values.push(data.isActive ? 1 : 0);
    }

    if (sets.length === 0) return this.getById(id);

    sets.push("updated_at = ?");
    values.push(Math.floor(Date.now() / 1000));
    values.push(id);

    this.db
      .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);

    return this.getById(id);
  }

  delete(id: string): void {
    this.update(id, { isActive: false });
  }

  /** Get total cost for a project in a given time window. */
  getCost(projectPath: string, sinceTimestamp: number): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE project_path = ? AND timestamp >= ?",
      )
      .get(projectPath, sinceTimestamp) as any;
    return row?.total ?? 0;
  }

  /** Count sessions for a project. */
  getSessionCount(projectId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM sessions WHERE project_id = ?")
      .get(projectId) as any;
    return row?.count ?? 0;
  }
}

// ── Project Memory ──────────────────────────────────────────────────

function rowToMemory(row: any): ProjectMemoryEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    value: row.value,
    category: row.category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectMemoryRepository {
  constructor(private db: Database.Database) {}

  list(projectId: string, category?: string): ProjectMemoryEntry[] {
    if (category) {
      return this.db
        .prepare(
          "SELECT * FROM project_memory WHERE project_id = ? AND category = ? ORDER BY key",
        )
        .all(projectId, category)
        .map(rowToMemory);
    }
    return this.db
      .prepare(
        "SELECT * FROM project_memory WHERE project_id = ? ORDER BY category, key",
      )
      .all(projectId)
      .map(rowToMemory);
  }

  get(projectId: string, key: string): ProjectMemoryEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM project_memory WHERE project_id = ? AND key = ?")
      .get(projectId, key);
    return row ? rowToMemory(row) : undefined;
  }

  set(
    projectId: string,
    key: string,
    value: string,
    category = "general",
  ): ProjectMemoryEntry {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO project_memory (project_id, key, value, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, category = excluded.category, updated_at = excluded.updated_at`,
      )
      .run(projectId, key, value, category, now, now);
    return this.get(projectId, key)!;
  }

  remove(projectId: string, key: string): void {
    this.db
      .prepare("DELETE FROM project_memory WHERE project_id = ? AND key = ?")
      .run(projectId, key);
  }
}
