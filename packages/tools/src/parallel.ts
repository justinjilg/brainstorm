/**
 * Parallel Tool Execution — determines which tools are safe to run concurrently.
 *
 * Tools declare concurrency safety via `concurrent` metadata on BrainstormToolDef.
 * Legacy fallback: hardcoded PARALLEL_SAFE / SEQUENTIAL_REQUIRED sets for tools
 * that haven't declared metadata yet. New tools should always set `concurrent`.
 *
 * The AI SDK v6 handles parallel tool calls natively — this module provides
 * the classification for when the agent loop needs to manage execution order.
 */

import type { BrainstormToolDef } from "./base.js";

/** Legacy fallback: tools known to be safe for parallel execution. */
const PARALLEL_SAFE_LEGACY = new Set([
  "file_read",
  "grep",
  "glob",
  "list_dir",
  "git_status",
  "git_diff",
  "git_log",
  "br_status",
  "br_budget",
  "br_leaderboard",
  "br_insights",
  "br_models",
  "br_memory_search",
  "br_health",
  "scratchpad_read",
  "cost_estimate",
  "plan_preview",
]);

/** Legacy fallback: tools that must execute sequentially. */
const SEQUENTIAL_REQUIRED_LEGACY = new Set([
  "file_write",
  "file_edit",
  "multi_edit",
  "batch_edit",
  "shell",
  "git_commit",
  "git_branch",
  "git_stash",
  "gh_pr",
  "gh_issue",
  "process_spawn",
  "process_kill",
  "scratchpad_write",
  "br_memory_store",
  "undo_last_write",
  "set_routing_hint",
  "ask_user",
]);

/** Optional tool registry for metadata-based classification. */
let _toolRegistry: Map<string, BrainstormToolDef> | null = null;

/** Set the tool registry for metadata-based parallel classification. */
export function setToolRegistryForParallel(
  registry: Map<string, BrainstormToolDef>,
): void {
  _toolRegistry = registry;
}

/**
 * Check if a tool is safe to execute in parallel.
 * Priority: tool metadata `concurrent` field > legacy hardcoded sets > default sequential.
 */
export function isParallelSafe(toolName: string): boolean {
  // Check tool metadata first (if registry is set)
  if (_toolRegistry) {
    const toolDef = _toolRegistry.get(toolName);
    if (toolDef?.concurrent !== undefined) return toolDef.concurrent;
  }
  // Fall back to legacy hardcoded sets
  return PARALLEL_SAFE_LEGACY.has(toolName);
}

/** Classify a batch of tool calls into parallel and sequential groups. */
export function classifyToolBatch(toolNames: string[]): {
  parallel: string[];
  sequential: string[];
} {
  const parallel: string[] = [];
  const sequential: string[] = [];

  for (const name of toolNames) {
    if (isParallelSafe(name)) {
      parallel.push(name);
    } else {
      sequential.push(name);
    }
  }

  return { parallel, sequential };
}

/**
 * Execute tool calls with parallel optimization.
 * Parallel-safe tools run via Promise.allSettled(), sequential tools run in order.
 */
export async function executeWithParallelism<T>(
  calls: Array<{ name: string; execute: () => Promise<T> }>,
): Promise<Array<{ name: string; result: T; error?: string }>> {
  const { parallel, sequential } = classifyToolBatch(calls.map((c) => c.name));
  const results: Array<{ name: string; result: T; error?: string }> = [];

  // Run parallel-safe tools concurrently
  const parallelCalls = calls.filter((c) => parallel.includes(c.name));
  if (parallelCalls.length > 1) {
    const settled = await Promise.allSettled(
      parallelCalls.map(async (c) => ({
        name: c.name,
        result: await c.execute(),
      })),
    );
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        results.push({
          name: parallelCalls[i].name,
          result: null as T,
          error: s.reason?.message ?? "Failed",
        });
      }
    }
  } else {
    // Single parallel call — just execute normally
    for (const c of parallelCalls) {
      results.push({ name: c.name, result: await c.execute() });
    }
  }

  // Run sequential tools in order
  const sequentialCalls = calls.filter((c) => sequential.includes(c.name));
  for (const c of sequentialCalls) {
    try {
      results.push({ name: c.name, result: await c.execute() });
    } catch (err: any) {
      results.push({ name: c.name, result: null as T, error: err.message });
    }
  }

  return results;
}
