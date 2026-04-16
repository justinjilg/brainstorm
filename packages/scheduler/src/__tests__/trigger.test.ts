import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getTestDb } from "@brainst0rm/db";
import { TriggerRunner } from "../trigger.js";
import { ScheduledTaskRepository, TaskRunRepository } from "../repository.js";
import type Database from "better-sqlite3";

describe("TriggerRunner", () => {
  let db: Database.Database;
  let runner: TriggerRunner;
  let taskRepo: ScheduledTaskRepository;
  let runRepo: TaskRunRepository;

  beforeEach(() => {
    db = getTestDb();

    // We need a dummy project to satisfy foreign key constraints
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `
      INSERT INTO projects (id, name, path, description, created_at, updated_at) 
      VALUES ('proj-1', 'Test Project', '/test', 'A test project', ?, ?)
    `,
    ).run(now, now);

    runner = new TriggerRunner(db, { maxConcurrent: 2 });
    taskRepo = new ScheduledTaskRepository(db);
    runRepo = new TaskRunRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should return empty result if no due tasks", async () => {
    const result = await runner.runDueTasks();
    expect(result.tasksChecked).toBe(0);
    expect(result.tasksRun).toBe(0);
    expect(result.runs).toEqual([]);
  });

  it("should execute due one-shot tasks without a cron expression", async () => {
    const task = taskRepo.create({
      projectId: "proj-1",
      name: "One Shot Task",
      prompt: "Do something once",
    });

    const executor = vi.fn().mockResolvedValue({
      outputSummary: "Success",
      cost: 0.05,
      turnsUsed: 3,
    });
    runner.setExecutor(executor);

    const result = await runner.runDueTasks();

    expect(result.tasksChecked).toBe(1);
    expect(result.tasksRun).toBe(1);
    expect(result.runs[0].taskName).toBe("One Shot Task");
    expect(result.runs[0].status).toBe("completed");
    expect(result.runs[0].cost).toBe(0.05);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      expect.objectContaining({ taskId: task.id }),
    );

    // Running again should not execute it since it's one-shot and already run
    const result2 = await runner.runDueTasks();
    expect(result2.tasksChecked).toBe(1);
    expect(result2.tasksRun).toBe(0);
  });

  it("should fail task gracefully if no executor is set", async () => {
    taskRepo.create({
      projectId: "proj-1",
      name: "No Executor Task",
      prompt: "Will fail",
    });

    // No executor set
    const result = await runner.runDueTasks();

    expect(result.tasksRun).toBe(1); // It attempted to run
    expect(result.runs[0].status).toBe("failed");

    // Check that the error was recorded in the DB
    const runInDb = runRepo.getById(result.runs[0].runId);
    expect(runInDb?.error).toBe("AGENT_LOOP_NOT_CONNECTED");
  });

  it("should respect maxConcurrent limit", async () => {
    taskRepo.create({ projectId: "proj-1", name: "Task 1", prompt: "T1" });
    taskRepo.create({ projectId: "proj-1", name: "Task 2", prompt: "T2" });
    taskRepo.create({ projectId: "proj-1", name: "Task 3", prompt: "T3" });

    const executor = vi.fn().mockImplementation(async () => {
      // Simulate taking time so we can check running status
      return { outputSummary: "Done", cost: 0.01, turnsUsed: 1 };
    });
    runner.setExecutor(executor);

    // Remember: maxConcurrent is set to 2 in beforeEach
    const result = await runner.runDueTasks();

    expect(result.tasksChecked).toBe(3);
    expect(result.tasksRun).toBe(2); // Only 2 should run
    expect(result.tasksSkipped).toBe(1); // 1 skipped due to concurrency
  });

  it("should handle dryRun without modifying db state", async () => {
    taskRepo.create({
      projectId: "proj-1",
      name: "Dry Run Task",
      prompt: "Safe task",
      allowMutations: false,
    });

    const result = await runner.runDueTasks({ dryRun: true });

    expect(result.tasksRun).toBe(1);
    expect(result.runs[0].status).toBe(
      "warnings: No budget limit set. Task could run up unlimited costs.",
    );
    expect(result.runs[0].runId).toBe("dry-run");

    // DB should have no task runs
    const recentRuns = runRepo.listRecent(10);
    expect(recentRuns).toHaveLength(0);
  });

  it("should return due task summaries for getDueTaskSummaries", () => {
    taskRepo.create({
      projectId: "proj-1",
      name: "Summary Task",
      prompt: "Short prompt",
    });
    // This is due because it's one-shot and hasn't been run

    const summaries = runner.getDueTaskSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toBe("[one-shot] Summary Task: Short prompt");
  });

  it("sweeps zombie 'running' rows left over from a prior process crash", async () => {
    // Seed a zombie: a running row directly in the DB, as if the previous
    // process had crashed mid-run without finishing the row.
    const task = taskRepo.create({
      projectId: "proj-1",
      name: "Zombie Owner",
      prompt: "anything",
    });
    const before = runRepo.create({ taskId: task.id, triggerType: "cron" });
    runRepo.markRunning(before.id);
    // Confirm the zombie exists before restart.
    expect(runRepo.getById(before.id)?.status).toBe("running");

    // Instantiating a fresh TriggerRunner simulates process restart; the
    // constructor must sweep the zombie.
    new TriggerRunner(db, { maxConcurrent: 2 });

    const after = runRepo.getById(before.id);
    expect(after?.status).toBe("crashed");
    expect(after?.completedAt).toBeTypeOf("number");
  });

  it("does not stamp completed_at on the running transition", async () => {
    const task = taskRepo.create({
      projectId: "proj-1",
      name: "In-flight",
      prompt: "p",
    });
    const run = runRepo.create({ taskId: task.id, triggerType: "cron" });
    runRepo.markRunning(run.id);

    const row = runRepo.getById(run.id);
    expect(row?.status).toBe("running");
    expect(row?.completedAt).toBeUndefined();
  });
});
