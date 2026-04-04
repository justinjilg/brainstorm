/**
 * OrchestrationEngine — coordinates work across multiple projects.
 *
 * Flow:
 * 1. Receives a high-level request + list of target projects
 * 2. Generates per-project tasks (via planner or direct decomposition)
 * 3. Executes tasks in dependency order, each in its own project context
 * 4. Aggregates results into a unified summary
 *
 * Each project task runs as an isolated subagent scoped to that project's directory.
 */

import type Database from "better-sqlite3";
import type {
  OrchestrationRun,
  OrchestrationTask,
  Project,
} from "@brainst0rm/shared";
import {
  OrchestrationRunRepository,
  OrchestrationTaskRepository,
} from "./repository.js";
import { ProjectRepository } from "@brainst0rm/projects";

// ── Event Types ─────────────────────────────────────────────────────

export type OrchestrationEvent =
  | { type: "plan-ready"; run: OrchestrationRun; tasks: OrchestrationTask[] }
  | { type: "task-started"; task: OrchestrationTask; project: Project }
  | {
      type: "task-completed";
      task: OrchestrationTask;
      project: Project;
      summary: string;
      cost: number;
    }
  | {
      type: "task-failed";
      task: OrchestrationTask;
      project: Project;
      error: string;
    }
  | {
      type: "orchestration-completed";
      run: OrchestrationRun;
      results: Array<{ projectName: string; summary: string; cost: number }>;
    }
  | { type: "orchestration-failed"; run: OrchestrationRun; error: string };

// ── Engine ──────────────────────────────────────────────────────────

export interface OrchestrationOptions {
  description: string;
  projectNames: string[];
  budgetLimit?: number;
  subagentType?: string;
  /** Optional: provide pre-decomposed per-project prompts */
  perProjectPrompts?: Map<string, string>;
  /** Callback to execute a task in a project context */
  executeTask?: (
    project: Project,
    prompt: string,
    opts: { budget: number; subagentType: string },
  ) => Promise<{ summary: string; cost: number }>;
}

export class OrchestrationEngine {
  private runs: OrchestrationRunRepository;
  private tasks: OrchestrationTaskRepository;
  private projects: ProjectRepository;

  constructor(private db: Database.Database) {
    this.runs = new OrchestrationRunRepository(db);
    this.tasks = new OrchestrationTaskRepository(db);
    this.projects = new ProjectRepository(db);
  }

  /**
   * Run an orchestration as an async generator yielding events.
   */
  async *run(opts: OrchestrationOptions): AsyncGenerator<OrchestrationEvent> {
    // Resolve project names to Project records
    const resolvedProjects: Project[] = [];
    for (const name of opts.projectNames) {
      const project = this.projects.getByName(name);
      if (!project) {
        throw new Error(
          `Project "${name}" not found. Run 'storm projects list' to see registered projects.`,
        );
      }
      resolvedProjects.push(project);
    }

    // Create orchestration run
    const orchestrationRun = this.runs.create({
      name: opts.description.slice(0, 100),
      description: opts.description,
      projectIds: resolvedProjects.map((p) => p.id),
      budgetLimit: opts.budgetLimit,
    });

    this.runs.updateStatus(orchestrationRun.id, "running");

    // Create per-project tasks
    // Allocate budget evenly across projects — no slack, hard ceiling
    const budgetPerProject = opts.budgetLimit
      ? opts.budgetLimit / resolvedProjects.length
      : undefined;

    const orchestrationTasks: OrchestrationTask[] = [];
    for (const project of resolvedProjects) {
      const prompt =
        opts.perProjectPrompts?.get(project.name) ??
        `In the context of the "${project.name}" project at ${project.path}:\n\n${opts.description}`;

      const task = this.tasks.create({
        runId: orchestrationRun.id,
        projectId: project.id,
        prompt,
        subagentType: opts.subagentType ?? "code",
      });
      orchestrationTasks.push(task);
    }

    yield {
      type: "plan-ready",
      run: orchestrationRun,
      tasks: orchestrationTasks,
    };

    // Execute tasks (currently sequential — parallel with dep resolution in future)
    const results: Array<{
      projectName: string;
      summary: string;
      cost: number;
    }> = [];
    let totalCost = 0;

    for (let i = 0; i < orchestrationTasks.length; i++) {
      const task = orchestrationTasks[i];
      const project = resolvedProjects[i];

      this.tasks.updateStatus(task.id, "running");
      yield { type: "task-started", task, project };

      try {
        let summary: string;
        let cost: number;

        if (opts.executeTask) {
          // Use provided execution callback (wired to real agent loop)
          const result = await opts.executeTask(project, task.prompt, {
            budget: budgetPerProject ?? 1.0,
            subagentType: opts.subagentType ?? "code",
          });
          summary = result.summary;
          cost = result.cost;
        } else {
          // Placeholder: no agent loop available
          summary = `[Placeholder] Would execute in ${project.name}: ${task.prompt.slice(0, 80)}...`;
          cost = 0;
        }

        totalCost += cost;

        this.tasks.updateStatus(task.id, "completed", {
          resultSummary: summary,
          cost,
        });

        results.push({ projectName: project.name, summary, cost });
        yield { type: "task-completed", task, project, summary, cost };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.tasks.updateStatus(task.id, "failed", {
          resultSummary: error,
          cost: 0,
        });
        yield { type: "task-failed", task, project, error };

        // Continue with remaining projects (don't fail the whole orchestration)
        results.push({
          projectName: project.name,
          summary: `FAILED: ${error}`,
          cost: 0,
        });
      }
    }

    // Mark orchestration complete
    this.runs.updateStatus(orchestrationRun.id, "completed", totalCost);
    const updatedRun = this.runs.getById(orchestrationRun.id)!;

    yield { type: "orchestration-completed", run: updatedRun, results };
  }

  /** Get run details with all tasks. */
  getRunWithTasks(
    runId: string,
  ): { run: OrchestrationRun; tasks: OrchestrationTask[] } | undefined {
    const run = this.runs.getById(runId);
    if (!run) return undefined;
    const tasks = this.tasks.listByRun(runId);
    return { run, tasks };
  }

  /** List recent orchestration runs. */
  listRecent(limit = 10): OrchestrationRun[] {
    return this.runs.listRecent(limit);
  }

  /** Cancel a running orchestration. */
  cancel(runId: string): void {
    const run = this.runs.getById(runId);
    if (!run || run.status !== "running") return;

    // Cancel pending tasks
    const tasks = this.tasks.listByRun(runId);
    for (const task of tasks) {
      if (task.status === "pending") {
        this.tasks.updateStatus(task.id, "skipped");
      }
    }

    this.runs.updateStatus(runId, "cancelled");
  }
}
