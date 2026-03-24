import type { ToolRegistry } from '@brainstorm/tools';

/**
 * Plan Mode — read-only exploration before execution.
 *
 * In plan mode:
 * - Only read-only tools are available (file_read, glob, grep, git_status, git_log)
 * - Write tools (file_write, file_edit, shell, git_commit) are blocked
 * - The model explores the codebase and produces a plan
 * - Plan is saved to .brainstorm/plans/
 * - User approves → switch to execute mode with plan as guide
 */

const READ_ONLY_TOOLS = new Set([
  'file_read', 'glob', 'grep', 'git_status', 'git_diff', 'git_log',
  'web_fetch', 'web_search', 'notebook_read',
]);

/**
 * Filter a tool registry to only read-only tools (for plan mode).
 */
export function getPlanModeTools(registry: ToolRegistry): Record<string, any> {
  const allTools = registry.getAll();
  const result: Record<string, any> = {};

  for (const tool of allTools) {
    if (READ_ONLY_TOOLS.has(tool.name) || tool.permission === 'auto') {
      result[tool.name] = tool.toAISDKTool();
    }
  }

  return result;
}

/**
 * Build the plan mode system prompt addition.
 */
export function getPlanModePrompt(): string {
  return `\n\n## Plan Mode Active

You are in PLAN MODE. You can ONLY use read-only tools (file_read, glob, grep, git_status, git_diff, git_log).
You CANNOT modify files, run shell commands, or make commits.

Your job is to:
1. Explore the codebase to understand the current state
2. Design an implementation approach
3. List the files you would modify and what changes you would make
4. Present the plan for user approval

Be thorough in your exploration. Read relevant files, search for patterns, and understand existing architecture before proposing changes.`;
}
