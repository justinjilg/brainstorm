/**
 * OrchestrationEngine tests.
 *
 * Exercises the async generator's event sequence, state transitions,
 * and task-runner callback wiring without touching real agents.
 *
 * We build a minimal in-memory SQLite schema (just the tables the engine
 * actually touches) so we don't pull in the full @brainst0rm/db migration
 * stack — it's not a direct dependency of this package.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Project } from "@brainst0rm/shared";
import { OrchestrationEngine, type OrchestrationEvent } from "../engine.js";

/**
 * Minimal schema: the engine reaches into `projects` via ProjectRepository
 * and into `orchestration_runs` / `orchestration_tasks` via its own repos.
 * `sessions` exists solely to satisfy FK constraints on
 * orchestration_runs.lead_session_id / orchestration_tasks.session_id.
 */
const SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    custom_instructions TEXT,
    knowledge_files TEXT NOT NULL DEFAULT '[]',
    budget_daily REAL,
    budget_monthly REAL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE orchestration_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    lead_session_id TEXT REFERENCES sessions(id),
    status TEXT NOT NULL DEFAULT 'pending',
    project_ids TEXT NOT NULL DEFAULT '[]',
    budget_limit REAL,
    total_cost REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE orchestration_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    subagent_type TEXT NOT NULL DEFAULT 'code',
    result_summary TEXT,
    cost REAL NOT NULL DEFAULT 0,
    session_id TEXT REFERENCES sessions(id),
    depends_on TEXT NOT NULL DEFAULT '[]',
    started_at INTEGER,
    completed_at INTEGER
  );
`;

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

function insertProject(db: Database.Database, name: string): Project {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO projects (id, name, path, description, knowledge_files, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, name, `/tmp/${name}`, `${name} description`, "[]", now, now);
  return {
    id,
    name,
    path: `/tmp/${name}`,
    description: `${name} description`,
    knowledgeFiles: [],
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

async function collect(
  gen: AsyncGenerator<OrchestrationEvent>,
): Promise<OrchestrationEvent[]> {
  const out: OrchestrationEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
});

afterEach(() => {
  db.close();
});

describe("OrchestrationEngine.run", () => {
  it("emits plan-ready then task-started/completed per project then orchestration-completed in order", async () => {
    insertProject(db, "alpha");
    insertProject(db, "beta");
    const engine = new OrchestrationEngine(db);

    const runTask = vi.fn(async (project: Project) => ({
      summary: `done ${project.name}`,
      cost: 0.05,
    }));

    const events = await collect(
      engine.run({
        description: "sync deps",
        projectNames: ["alpha", "beta"],
        executeTask: runTask,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "plan-ready",
      "task-started",
      "task-completed",
      "task-started",
      "task-completed",
      "orchestration-completed",
    ]);
    expect(runTask).toHaveBeenCalledTimes(2);
  });

  it("plan-ready yields one task per resolved project with generated prompts", async () => {
    insertProject(db, "alpha");
    insertProject(db, "beta");
    const engine = new OrchestrationEngine(db);

    const events = await collect(
      engine.run({
        description: "audit security",
        projectNames: ["alpha", "beta"],
        executeTask: async () => ({ summary: "ok", cost: 0 }),
      }),
    );

    const plan = events.find((e) => e.type === "plan-ready");
    expect(plan?.type).toBe("plan-ready");
    if (plan?.type !== "plan-ready") throw new Error("unreachable");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].prompt).toContain("alpha");
    expect(plan.tasks[0].prompt).toContain("audit security");
    expect(plan.tasks[1].prompt).toContain("beta");
  });

  it("splits budget evenly across projects when budgetLimit is provided", async () => {
    insertProject(db, "alpha");
    insertProject(db, "beta");
    insertProject(db, "gamma");
    const engine = new OrchestrationEngine(db);

    const runTask = vi.fn(async () => ({ summary: "ok", cost: 0.1 }));

    await collect(
      engine.run({
        description: "rollout",
        projectNames: ["alpha", "beta", "gamma"],
        budgetLimit: 3.0,
        executeTask: runTask,
      }),
    );

    // Each call should receive budgetLimit / N = 1.0
    for (const call of runTask.mock.calls) {
      const [, , opts] = call;
      expect(opts.budget).toBe(1.0);
    }
  });

  it("uses perProjectPrompts overrides when supplied", async () => {
    insertProject(db, "alpha");
    insertProject(db, "beta");
    const engine = new OrchestrationEngine(db);

    const overrides = new Map([
      ["alpha", "CUSTOM alpha prompt"],
      // beta left out → should fall back to generated prompt
    ]);

    const events = await collect(
      engine.run({
        description: "fallback check",
        projectNames: ["alpha", "beta"],
        perProjectPrompts: overrides,
        executeTask: async () => ({ summary: "ok", cost: 0 }),
      }),
    );

    const plan = events.find((e) => e.type === "plan-ready");
    if (plan?.type !== "plan-ready") throw new Error("unreachable");
    expect(plan.tasks[0].prompt).toBe("CUSTOM alpha prompt");
    expect(plan.tasks[1].prompt).toContain("beta");
    expect(plan.tasks[1].prompt).toContain("fallback check");
  });

  it("uses placeholder summary and zero cost when no task runner is provided", async () => {
    insertProject(db, "alpha");
    const engine = new OrchestrationEngine(db);

    const events = await collect(
      engine.run({
        description: "dry run",
        projectNames: ["alpha"],
      }),
    );

    const completed = events.find((e) => e.type === "task-completed");
    if (completed?.type !== "task-completed") throw new Error("unreachable");
    expect(completed.cost).toBe(0);
    expect(completed.summary).toContain("[Placeholder]");
    expect(completed.summary).toContain("alpha");
  });

  it("emits task-failed for a throwing runner but continues remaining projects", async () => {
    insertProject(db, "alpha");
    insertProject(db, "beta");
    const engine = new OrchestrationEngine(db);

    const runTask = vi.fn(async (project: Project) => {
      if (project.name === "alpha") throw new Error("boom");
      return { summary: "beta ok", cost: 0.2 };
    });

    const events = await collect(
      engine.run({
        description: "partial failure",
        projectNames: ["alpha", "beta"],
        executeTask: runTask,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("task-failed");
    expect(types).toContain("task-completed");
    // Orchestration still finishes (failures don't abort the run)
    expect(types[types.length - 1]).toBe("orchestration-completed");

    const failed = events.find((e) => e.type === "task-failed");
    if (failed?.type !== "task-failed") throw new Error("unreachable");
    expect(failed.error).toBe("boom");

    const final = events[events.length - 1];
    if (final.type !== "orchestration-completed")
      throw new Error("unreachable");
    // Only beta's cost (0.2) should be accumulated on the run
    expect(final.run.totalCost).toBeCloseTo(0.2, 5);
    // Results include both projects; failed one prefixed with "FAILED:"
    expect(final.results).toHaveLength(2);
    const alphaResult = final.results.find((r) => r.projectName === "alpha");
    expect(alphaResult?.summary).toContain("FAILED:");
    expect(alphaResult?.cost).toBe(0);
  });

  it("throws when a project name does not resolve", async () => {
    insertProject(db, "alpha");
    const engine = new OrchestrationEngine(db);

    const gen = engine.run({
      description: "missing project",
      projectNames: ["alpha", "ghost"],
      executeTask: async () => ({ summary: "ok", cost: 0 }),
    });

    await expect(collect(gen)).rejects.toThrow(/ghost/);
  });

  it("persists completed run state so getRunWithTasks reflects the terminal status", async () => {
    insertProject(db, "alpha");
    const engine = new OrchestrationEngine(db);

    const events = await collect(
      engine.run({
        description: "persistence check",
        projectNames: ["alpha"],
        executeTask: async () => ({ summary: "done", cost: 0.42 }),
      }),
    );

    const plan = events.find((e) => e.type === "plan-ready");
    if (plan?.type !== "plan-ready") throw new Error("unreachable");

    const runId = plan.run.id;
    const fetched = engine.getRunWithTasks(runId);
    expect(fetched).toBeDefined();
    expect(fetched!.run.status).toBe("completed");
    expect(fetched!.run.totalCost).toBeCloseTo(0.42, 5);
    expect(fetched!.tasks).toHaveLength(1);
    expect(fetched!.tasks[0].status).toBe("completed");
    expect(fetched!.tasks[0].resultSummary).toBe("done");
  });
});

describe("OrchestrationEngine.cancel", () => {
  it("flips a running run to cancelled and skips its pending tasks", async () => {
    insertProject(db, "alpha");
    insertProject(db, "beta");
    const engine = new OrchestrationEngine(db);

    // Insert a running run + mixed-status tasks straight into the DB so we
    // can exercise the cancel() code path deterministically without racing
    // the async generator.
    const runId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO orchestration_runs (id, name, description, status, project_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    ).run(runId, "live", "live run", "[]", now, now);

    const alpha = db
      .prepare("SELECT id FROM projects WHERE name = 'alpha'")
      .get() as { id: string };
    const beta = db
      .prepare("SELECT id FROM projects WHERE name = 'beta'")
      .get() as { id: string };

    db.prepare(
      `INSERT INTO orchestration_tasks (id, run_id, project_id, prompt, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    ).run(randomUUID(), runId, alpha.id, "p1");
    db.prepare(
      `INSERT INTO orchestration_tasks (id, run_id, project_id, prompt, status)
       VALUES (?, ?, ?, ?, 'running')`,
    ).run(randomUUID(), runId, beta.id, "p2");

    engine.cancel(runId);

    const fetched = engine.getRunWithTasks(runId)!;
    expect(fetched.run.status).toBe("cancelled");
    const statuses = fetched.tasks.map((t) => t.status).sort();
    // pending → skipped; running is left alone
    expect(statuses).toEqual(["running", "skipped"]);
  });

  it("is a no-op for non-running runs", async () => {
    insertProject(db, "alpha");
    const engine = new OrchestrationEngine(db);

    const runId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO orchestration_runs (id, name, description, status, project_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
    ).run(runId, "done", "done run", "[]", now, now);

    engine.cancel(runId);
    const fetched = engine.getRunWithTasks(runId)!;
    expect(fetched.run.status).toBe("completed");
  });
});
