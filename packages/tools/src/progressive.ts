/**
 * Progressive Tool Loading — load tools by tier based on task complexity.
 *
 * Instead of injecting all 58+ tool descriptions into every system prompt (~4500 tokens),
 * load tools progressively:
 *   - minimal (5 tools): simple Q&A, file reads, basic edits
 *   - standard (20 tools): code editing, git, search, tasks
 *   - full (58+ tools): transactions, undo, BR intelligence, web, batch ops, code graph, memory
 *
 * Inspired by DeerFlow's progressive skill loading, but task-aware:
 * the router's task classifier determines which tier to start with.
 * If the model requests a tool not in the current tier, escalate automatically.
 */

import type { Complexity } from "@brainst0rm/shared";

export type ToolTier = "minimal" | "standard" | "full";

/** Tools included in each tier. */
const TIER_TOOLS: Record<ToolTier, string[]> = {
  minimal: ["file_read", "file_write", "file_edit", "shell", "glob"],
  standard: [
    // All minimal tools
    "file_read",
    "file_write",
    "file_edit",
    "shell",
    "glob",
    // Git
    "git_status",
    "git_diff",
    "git_log",
    "git_commit",
    "git_branch",
    "git_stash",
    // Search
    "grep",
    "list_dir",
    // Multi-file
    "multi_edit",
    // Tasks
    "task_create",
    "task_update",
    "task_list",
    // Agent
    "scratchpad_write",
    "scratchpad_read",
    "ask_user",
  ],
  full: [
    // All standard tools
    "file_read",
    "file_write",
    "file_edit",
    "shell",
    "glob",
    "git_status",
    "git_diff",
    "git_log",
    "git_commit",
    "git_branch",
    "git_stash",
    "grep",
    "list_dir",
    "multi_edit",
    "task_create",
    "task_update",
    "task_list",
    "scratchpad_write",
    "scratchpad_read",
    "ask_user",
    // Batch ops
    "batch_edit",
    // GitHub
    "gh_pr",
    "gh_issue",
    // Web
    "web_fetch",
    "web_search",
    // Process management
    "process_spawn",
    "process_kill",
    // Undo + Transactions
    "undo_last_write",
    "begin_transaction",
    "commit_transaction",
    "rollback_transaction",
    // Routing + Cost
    "set_routing_hint",
    "cost_estimate",
    "plan_preview",
    // BrainstormRouter intelligence
    "br_status",
    "br_budget",
    "br_leaderboard",
    "br_insights",
    "br_models",
    "br_memory_search",
    "br_memory_store",
    "br_health",
  ],
};

/** Map task complexity to initial tool tier. */
const COMPLEXITY_TO_TIER: Record<Complexity, ToolTier> = {
  trivial: "minimal",
  simple: "minimal",
  moderate: "standard",
  complex: "full",
  expert: "full",
};

/** Get the tool tier for a given task complexity. */
export function getTierForComplexity(complexity: Complexity): ToolTier {
  return COMPLEXITY_TO_TIER[complexity];
}

/** All tool names known to the tier system (built-in tools). */
const ALL_TIERED_TOOLS = new Set(TIER_TOOLS.full);

/**
 * Get tool names for a given tier.
 * Always includes dynamically registered tools (God Mode, MCP, plugins)
 * that aren't in any tier — these are the reason the user may be talking
 * to the system and must never be filtered out.
 */
export function getToolsForTier(
  tier: ToolTier,
  allRegisteredTools?: string[],
): string[] {
  const tierTools = TIER_TOOLS[tier];
  if (!allRegisteredTools) return tierTools;

  // Include any tool not in the tier system (external/dynamic tools)
  const dynamicTools = allRegisteredTools.filter(
    (name) => !ALL_TIERED_TOOLS.has(name),
  );
  return [...tierTools, ...dynamicTools];
}

/** Check if a tool is available in the current tier. */
export function isToolInTier(toolName: string, tier: ToolTier): boolean {
  return TIER_TOOLS[tier].includes(toolName);
}

/** Get the next tier up (for escalation). Returns null if already at full. */
export function escalateTier(current: ToolTier): ToolTier | null {
  if (current === "minimal") return "standard";
  if (current === "standard") return "full";
  return null;
}

/** Get tier that contains a specific tool (for escalation targeting). */
export function getTierForTool(toolName: string): ToolTier | null {
  if (TIER_TOOLS.minimal.includes(toolName)) return "minimal";
  if (TIER_TOOLS.standard.includes(toolName)) return "standard";
  if (TIER_TOOLS.full.includes(toolName)) return "full";
  return null; // Unknown tool (plugin or MCP)
}

/** Get token estimate saved by using a lower tier. */
export function estimateTokenSavings(currentTier: ToolTier): {
  toolsOmitted: number;
  estimatedTokensSaved: number;
} {
  const fullCount = TIER_TOOLS.full.length;
  const currentCount = TIER_TOOLS[currentTier].length;
  const omitted = fullCount - currentCount;
  // Average tool description ~70 tokens (name + description + schema)
  return { toolsOmitted: omitted, estimatedTokensSaved: omitted * 70 };
}
