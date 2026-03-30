/**
 * Self-Extending Plans — PM agent generates next tasks when plan completes.
 *
 * When all tasks in a plan are done, instead of stopping, this module
 * spawns the PM agent with context of completed tasks and their outputs.
 * The PM generates the next batch of tasks, which are appended to the plan.
 *
 * Guards:
 * - Max 3 extensions per session (prevent infinite loops)
 * - Only extends if all completed tasks succeeded (no failed tasks)
 * - Each extension is logged in plan metadata
 *
 * Learned from: Living Case Study — the orchestrator stopped when Sprint 1
 * was done. We had to manually define Sprint 2. This makes it automatic.
 */

import type { PlanFile, PlanTask } from "./types.js";

export interface SelfExtendResult {
  extended: boolean;
  reason: string;
  newTasks?: PlanTask[];
  extensionCount: number;
}

/**
 * Check if a plan is eligible for self-extension.
 */
export function canSelfExtend(
  plan: PlanFile,
  extensionCount: number,
): { eligible: boolean; reason: string } {
  if (extensionCount >= 3) {
    return { eligible: false, reason: "Maximum 3 self-extensions reached" };
  }

  // Check all tasks are completed (no failed/blocked)
  const allTasks = plan.phases.flatMap((p) =>
    p.sprints.flatMap((s) => s.tasks),
  );
  const failed = allTasks.filter(
    (t) => t.status === "failed" || t.status === "blocked",
  );
  if (failed.length > 0) {
    return {
      eligible: false,
      reason: `${failed.length} task(s) failed — fix them before extending`,
    };
  }

  const pending = allTasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  );
  if (pending.length > 0) {
    return {
      eligible: false,
      reason: `${pending.length} task(s) still pending`,
    };
  }

  return { eligible: true, reason: "All tasks complete, extension eligible" };
}

/**
 * Build the prompt for the PM agent to generate next tasks.
 */
export function buildExtensionPrompt(plan: PlanFile): string {
  const completedTasks = plan.phases
    .flatMap((p) => p.sprints.flatMap((s) => s.tasks))
    .filter((t) => t.status === "completed")
    .map(
      (t) =>
        `- ${t.description} (${t.assignedSkill ?? "general"})${t.cost ? ` [$${t.cost.toFixed(4)}]` : ""}`,
    )
    .join("\n");

  return `The following plan tasks have been completed:\n\n${completedTasks}\n\nBased on what was accomplished, define the next 3-5 tasks that should be done. For each task, provide:\n- A clear, actionable description\n- The appropriate agent type (plan, code, review, research)\n- Whether it requires build verification\n\nFormat each task on its own line starting with "- [ ] " followed by the description.\n\nFocus on what naturally comes next — if code was written, the next tasks should be tests and reviews. If architecture was designed, the next tasks should be implementation.`;
}
