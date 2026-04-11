/**
 * Tests for the Planner/Worker/Judge worker-pool methods on
 * OrchestrationTaskRepository: claimNext, completeWithMetadata, failTask,
 * allTasksFinished.
 *
 * These are the primitives the multi-agent orchestrator builds on, so the
 * test focuses on the core safety properties:
 *   - claimNext is atomic (two callers don't get the same task)
 *   - dependencies are respected (a task isn't claimable until its deps are done)
 *   - allTasksFinished returns true only when no pending or in_progress work remains
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  OrchestrationRunRepository,
  OrchestrationTaskRepository,
} from "../repository.js";

const SCHEMA = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    knowledge_files TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
    completed_at INTEGER,
    assigned_worker TEXT,
    worktree_path TEXT,
    files_touched TEXT NOT NULL DEFAULT '[]',
    error TEXT
  );
`;

let db: Database.Database;
let runRepo: OrchestrationRunRepository;
let taskRepo: OrchestrationTaskRepository;
let runId: string;
let projectId: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  projectId = randomUUID();
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (?, ?, ?)`).run(
    projectId,
    "test",
    "/tmp/test",
  );

  runRepo = new OrchestrationRunRepository(db);
  taskRepo = new OrchestrationTaskRepository(db);
  const run = runRepo.create({
    name: "test run",
    description: "worker pool test",
    projectIds: [projectId],
  });
  runId = run.id;
});

afterEach(() => {
  db.close();
});

describe("OrchestrationTaskRepository worker-pool methods", () => {
  it("claimNext returns a pending task and marks it in_progress with the worker id", () => {
    const task = taskRepo.create({
      runId,
      projectId,
      prompt: "first task",
    });

    const claimed = taskRepo.claimNext(runId, "worker-1");

    expect(claimed).toBeDefined();
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.status).toBe("in_progress");
    expect(claimed?.assignedWorker).toBe("worker-1");
    expect(claimed?.startedAt).toBeGreaterThan(0);
  });

  it("claimNext returns undefined when there are no pending tasks", () => {
    expect(taskRepo.claimNext(runId, "worker-1")).toBeUndefined();
  });

  it("claimNext does not return a task whose dependencies aren't completed yet", () => {
    const upstream = taskRepo.create({ runId, projectId, prompt: "upstream" });
    const downstream = taskRepo.create({
      runId,
      projectId,
      prompt: "downstream",
      dependsOn: [upstream.id],
    });

    const first = taskRepo.claimNext(runId, "worker-1");
    expect(first?.id).toBe(upstream.id);

    expect(taskRepo.claimNext(runId, "worker-2")).toBeUndefined();

    taskRepo.completeWithMetadata(upstream.id, {
      resultSummary: "ok",
      cost: 0.05,
    });
    const second = taskRepo.claimNext(runId, "worker-2");
    expect(second?.id).toBe(downstream.id);
  });

  it("two concurrent claimNext calls never return the same task", () => {
    taskRepo.create({ runId, projectId, prompt: "a" });
    taskRepo.create({ runId, projectId, prompt: "b" });
    taskRepo.create({ runId, projectId, prompt: "c" });

    const claim1 = taskRepo.claimNext(runId, "worker-1");
    const claim2 = taskRepo.claimNext(runId, "worker-2");
    const claim3 = taskRepo.claimNext(runId, "worker-3");

    expect(claim1).toBeDefined();
    expect(claim2).toBeDefined();
    expect(claim3).toBeDefined();
    expect(new Set([claim1!.id, claim2!.id, claim3!.id]).size).toBe(3);
    expect(taskRepo.claimNext(runId, "worker-4")).toBeUndefined();
  });

  it("completeWithMetadata captures worktree path and files touched", () => {
    const task = taskRepo.create({ runId, projectId, prompt: "x" });
    taskRepo.claimNext(runId, "worker-1");

    taskRepo.completeWithMetadata(task.id, {
      resultSummary: "added 3 tests",
      cost: 0.42,
      worktreePath: "/tmp/wt-abc",
      filesTouched: ["packages/db/src/foo.ts", "packages/db/src/bar.ts"],
    });

    const reloaded = taskRepo.getById(task.id)!;
    expect(reloaded.status).toBe("completed");
    expect(reloaded.worktreePath).toBe("/tmp/wt-abc");
    expect(reloaded.filesTouched).toEqual([
      "packages/db/src/foo.ts",
      "packages/db/src/bar.ts",
    ]);
    expect(reloaded.cost).toBe(0.42);
    expect(reloaded.completedAt).toBeGreaterThan(0);
  });

  it("failTask records the error and marks status failed", () => {
    const task = taskRepo.create({ runId, projectId, prompt: "y" });
    taskRepo.claimNext(runId, "worker-1");

    taskRepo.failTask(task.id, "build failed: missing import");

    const reloaded = taskRepo.getById(task.id)!;
    expect(reloaded.status).toBe("failed");
    expect(reloaded.error).toBe("build failed: missing import");
    expect(reloaded.completedAt).toBeGreaterThan(0);
  });

  it("allTasksFinished returns false while any task is pending or in_progress", () => {
    const a = taskRepo.create({ runId, projectId, prompt: "a" });
    const b = taskRepo.create({ runId, projectId, prompt: "b" });

    expect(taskRepo.allTasksFinished(runId)).toBe(false);

    taskRepo.completeWithMetadata(a.id, {});
    expect(taskRepo.allTasksFinished(runId)).toBe(false);

    taskRepo.failTask(b.id, "boom");
    expect(taskRepo.allTasksFinished(runId)).toBe(true);
  });
});
