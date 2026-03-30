/**
 * PlanExecutor — autonomous multi-model plan execution engine.
 *
 * Reads a .plan.md file and works through it task-by-task:
 * 1. Parse plan into hierarchy (phases → sprints → tasks)
 * 2. For each pending task: classify → dispatch subagent → observe → record
 * 3. Handle failures with retries and model fallbacks
 * 4. Update plan file checkboxes on completion
 * 5. Track cost per task, per phase, per plan
 *
 * This is the Brainstorm equivalent of Claude Code's autonomous execution
 * pattern, but extended across all models via BrainstormRouter.
 */

import type {
  PlanFile,
  PlanPhase,
  PlanSprint,
  PlanTask,
  PlanEvent,
  PlanExecutorOptions,
  TaskDispatch,
} from "./types.js";
import { parsePlanFile, updateTaskInFile } from "./parser.js";
import { classifyPlanTask, estimateTaskCost } from "./classifier.js";

// ── Executor ────────────────────────────────────────────────────────

export interface SubagentDispatcher {
  /** Spawn a subagent to execute a task. Returns result summary + cost. */
  execute(
    prompt: string,
    opts: {
      subagentType: string;
      modelHint: string;
      budgetLimit: number;
      projectPath: string;
      skill?: string;
      routingStrategy?: string;
    },
  ): Promise<{
    text: string;
    cost: number;
    modelUsed: string;
    toolCalls: string[];
    budgetExceeded: boolean;
  }>;

  /** Run a build/test command and return pass/fail. */
  checkBuild(
    command: string,
    cwd: string,
  ): Promise<{ passed: boolean; output: string }>;
}

/**
 * Execute a plan file autonomously.
 *
 * Yields PlanEvent objects for real-time observation.
 * The caller provides a SubagentDispatcher that bridges to the actual agent loop.
 */
export async function* executePlan(
  planPath: string,
  dispatcher: SubagentDispatcher,
  options: PlanExecutorOptions,
): AsyncGenerator<PlanEvent> {
  const plan = parsePlanFile(planPath);
  const pendingTasks = countPending(plan);

  if (pendingTasks === 0) {
    if (options.selfExtend) {
      const { canSelfExtend } = await import("./self-extend.js");
      const extensionCount =
        (plan as unknown as Record<string, number>)._extensionCount ?? 0;
      const { eligible, reason } = canSelfExtend(plan, extensionCount);
      if (eligible) {
        yield {
          type: "plan-extending" as PlanEvent["type"],
          plan,
          reason: "All tasks complete, generating next batch",
        } as any;
        // The caller (agent loop) handles the actual extension by spawning PM agent
      }
    }
    yield { type: "plan-completed", plan, totalCost: 0 };
    return;
  }

  yield { type: "plan-started", plan, totalTasks: pendingTasks };

  // Dry-run mode: classify all tasks and show dispatch plan
  if (options.mode === "dry-run") {
    yield* dryRun(plan);
    return;
  }

  let totalCost = 0;
  let consecutiveFailures = 0;

  for (const phase of plan.phases) {
    if (phase.status === "completed") continue;

    yield { type: "phase-started", phase };
    let phaseCost = 0;

    for (const sprint of phase.sprints) {
      if (sprint.status === "completed") continue;

      yield { type: "sprint-started", sprint };

      for (const task of sprint.tasks) {
        if (task.status === "completed" || task.status === "skipped") continue;

        // Budget guard: check plan-level budget
        if (options.planBudgetLimit && totalCost >= options.planBudgetLimit) {
          yield {
            type: "plan-paused",
            reason: `Plan budget exceeded: $${totalCost.toFixed(2)} / $${options.planBudgetLimit.toFixed(2)}`,
          };
          return;
        }

        // Classify the task
        const dispatch = classifyPlanTask(task);

        // Build the prompt for the subagent
        const prompt = buildTaskPrompt(task, phase, plan);

        // Skill injection
        if (task.assignedSkill) {
          yield {
            type: "skill-activated",
            skillName: task.assignedSkill,
            taskId: task.id,
          };
        }

        // Execute with retry logic
        let attempt = 0;
        let succeeded = false;

        while (attempt < options.maxRetries && !succeeded) {
          attempt++;

          const modelHint =
            attempt === 1
              ? dispatch.modelHint
              : attempt === 2
                ? "capable" // retry with capable if first was cheap
                : "quality"; // escalate to quality on third attempt

          yield {
            type: "task-started",
            task,
            subagentType: dispatch.subagentType,
            model: modelHint,
          };

          if (attempt > 1) {
            yield {
              type: "task-retrying",
              task,
              model: modelHint,
              attempt,
            };
          }

          try {
            const result = await dispatcher.execute(prompt, {
              subagentType: dispatch.subagentType,
              modelHint,
              budgetLimit: options.defaultBudgetPerTask,
              projectPath: options.projectPath,
              skill: task.assignedSkill,
              routingStrategy: dispatch.routingStrategy,
            });

            if (result.budgetExceeded) {
              yield { type: "task-budget-exceeded", task, cost: result.cost };
              totalCost += result.cost;
              phaseCost += result.cost;
              break; // skip to next task
            }

            // Verify build if required
            if (dispatch.requiresVerification && options.buildCommand) {
              const buildResult = await dispatcher.checkBuild(
                options.buildCommand,
                options.projectPath,
              );
              yield { type: "build-check", ...buildResult };

              if (!buildResult.passed) {
                yield {
                  type: "task-failed",
                  task,
                  reason: "build-broken",
                  error: buildResult.output.slice(0, 500),
                };
                // Will retry if attempts remain
                continue;
              }
            }

            // Success!
            task.status = "completed";
            task.cost = result.cost;
            task.modelUsed = result.modelUsed;
            task.completedAt = Math.floor(Date.now() / 1000);
            totalCost += result.cost;
            phaseCost += result.cost;
            consecutiveFailures = 0;

            // Write back to plan file
            updateTaskInFile(plan.filePath, task, {
              completed: true,
              cost: result.cost,
              model: result.modelUsed,
              skill: task.assignedSkill,
            });

            yield {
              type: "task-completed",
              task,
              cost: result.cost,
              summary: result.text.slice(0, 500),
              model: result.modelUsed,
              toolCalls: result.toolCalls,
            };

            succeeded = true;
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            yield { type: "task-failed", task, reason: "error", error };
            consecutiveFailures++;

            // Safety: pause if too many consecutive failures
            if (consecutiveFailures >= 3) {
              yield {
                type: "plan-paused",
                reason: `3 consecutive task failures. Last error: ${error}`,
              };
              return;
            }
          }
        }

        if (!succeeded) {
          task.status = "failed";
          // In autonomous mode, skip failed tasks and continue
          // In interactive mode, the caller should pause
          if (options.mode === "interactive") {
            yield {
              type: "plan-paused",
              reason: `Task "${task.description}" failed after ${options.maxRetries} attempts`,
            };
            return;
          }
        }
      }
    }

    // Phase complete
    const phaseCompleted = phase.sprints.every((s) =>
      s.tasks.every((t) => t.status === "completed" || t.status === "skipped"),
    );
    if (phaseCompleted) {
      phase.status = "completed";
    }

    yield { type: "phase-completed", phase, cost: phaseCost };
  }

  // Plan complete
  plan.completedTasks = plan.phases.reduce(
    (sum, p) => sum + p.completedCount,
    0,
  );
  if (plan.completedTasks === plan.totalTasks) {
    plan.status = "completed";
  }

  yield { type: "plan-completed", plan, totalCost };
}

// ── Helpers ─────────────────────────────────────────────────────────

function countPending(plan: PlanFile): number {
  let count = 0;
  for (const phase of plan.phases) {
    for (const sprint of phase.sprints) {
      for (const task of sprint.tasks) {
        if (task.status !== "completed" && task.status !== "skipped") {
          count++;
        }
      }
    }
  }
  return count;
}

function buildTaskPrompt(
  task: PlanTask,
  phase: PlanPhase,
  plan: PlanFile,
): string {
  return [
    `You are working on plan: "${plan.name}"`,
    `Current phase: ${phase.name}`,
    "",
    `Task: ${task.description}`,
    "",
    "Complete this task. Be thorough but focused. Verify your work before declaring done.",
    task.assignedSkill
      ? `\nUse the ${task.assignedSkill} skill approach for this task.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function* dryRun(plan: PlanFile): AsyncGenerator<PlanEvent> {
  let totalEstimated = 0;
  const tasksByType: Record<string, number> = {};

  for (const phase of plan.phases) {
    for (const sprint of phase.sprints) {
      for (const task of sprint.tasks) {
        if (task.status === "completed") continue;

        const dispatch = classifyPlanTask(task);
        const estimated = estimateTaskCost(dispatch);
        totalEstimated += estimated;
        tasksByType[dispatch.subagentType] =
          (tasksByType[dispatch.subagentType] ?? 0) + 1;

        yield {
          type: "dry-run-task",
          task,
          dispatch,
          estimatedCost: estimated,
        };
      }
    }
  }

  yield {
    type: "dry-run-summary",
    totalTasks: countPending(plan),
    estimatedCost: totalEstimated,
    tasksByType,
  };
}
