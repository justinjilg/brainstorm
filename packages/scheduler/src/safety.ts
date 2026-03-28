/**
 * Safety layer for scheduled task execution.
 *
 * When allowMutations is false, filters the tool registry to read-only tools.
 * This matches the "explore" subagent pattern from packages/core/src/agent/subagent.ts.
 */

/** Tools that are safe for read-only scheduled execution. */
const READ_ONLY_TOOLS = new Set([
  "file_read",
  "glob",
  "grep",
  "list_dir",
  "git_status",
  "git_diff",
  "git_log",
  "git_blame",
  "web_search",
  "web_fetch",
  "task_list",
  "task_get",
]);

/** Tools that should never be available in scheduled tasks (even with mutations). */
const DENIED_TOOLS = new Set([
  "ask_user", // no human to answer
  "prompt_user", // no human to answer
]);

/**
 * Filter a tool list based on mutation permissions.
 */
export function filterToolsForSchedule(
  toolNames: string[],
  allowMutations: boolean,
): string[] {
  return toolNames.filter((name) => {
    if (DENIED_TOOLS.has(name)) return false;
    if (!allowMutations && !READ_ONLY_TOOLS.has(name)) return false;
    return true;
  });
}

/**
 * Get the allowed tool names for a scheduled task.
 */
export function getScheduleToolList(allowMutations: boolean): string[] {
  if (allowMutations) {
    // All tools except user-interactive ones
    return ["*"]; // signal to use full registry minus DENIED_TOOLS
  }
  return Array.from(READ_ONLY_TOOLS);
}

/**
 * Validate that a scheduled task is safe to run.
 * Returns an array of warning messages (empty = safe).
 */
export function validateTaskSafety(task: {
  prompt: string;
  allowMutations: boolean;
  budgetLimit?: number;
  maxTurns: number;
  timeoutMs: number;
}): string[] {
  const warnings: string[] = [];

  if (!task.budgetLimit || task.budgetLimit <= 0) {
    warnings.push("No budget limit set. Task could run up unlimited costs.");
  }

  if (task.budgetLimit && task.budgetLimit > 10) {
    warnings.push(
      `High budget limit: $${task.budgetLimit.toFixed(2)}. Consider reducing.`,
    );
  }

  if (task.maxTurns > 50) {
    warnings.push(`High turn limit: ${task.maxTurns}. Consider reducing.`);
  }

  if (task.timeoutMs > 1800000) {
    warnings.push(
      `Long timeout: ${task.timeoutMs / 60000} minutes. Consider reducing.`,
    );
  }

  if (task.allowMutations) {
    warnings.push(
      "Mutations enabled. Task can write files, run shell commands, and make git commits.",
    );

    // Check for dangerous patterns in the prompt
    const dangerousPatterns = [
      /rm\s+-rf/i,
      /drop\s+table/i,
      /delete\s+from/i,
      /force\s+push/i,
      /--force/i,
      /reset\s+--hard/i,
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(task.prompt)) {
        warnings.push(
          `Prompt contains potentially dangerous pattern: ${pattern.source}`,
        );
      }
    }
  }

  return warnings;
}
