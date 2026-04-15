/**
 * Auto-Reindex Hook — triggers incremental graph reindex after git commits.
 *
 * PostToolUse: when bash/shell runs a git commit, re-runs the indexing
 * pipeline on changed files so the graph stays fresh.
 *
 * Function-type hook — runs in-process.
 */

import type { HookDefinition, HookResult } from "../types.js";

interface AutoReindexOptions {
  /** Callback that runs the reindex. Returns number of files reindexed. */
  reindex: () => Promise<number>;
}

/**
 * Create auto-reindex hooks.
 * The reindex callback should run the code-graph pipeline incrementally.
 */
export function createAutoReindexHooks(
  opts: AutoReindexOptions,
): HookDefinition[] {
  return [
    {
      event: "PostToolUse",
      matcher: "bash|shell|git_commit",
      type: "function",
      command: "auto-reindex",
      description: "Auto-reindex code graph after git commits",
      fn: async (context): Promise<HookResult> => {
        // Only trigger on commit-like operations
        const command = String(context.command ?? context.input ?? "");
        const isCommit =
          command.includes("git commit") ||
          command.includes("git merge") ||
          context.toolName === "git_commit";

        if (!isCommit) {
          return {
            hookId: "auto-reindex",
            event: "PostToolUse",
            success: true,
            durationMs: 0,
          };
        }

        try {
          const filesReindexed = await opts.reindex();
          return {
            hookId: "auto-reindex",
            event: "PostToolUse",
            success: true,
            output: `Reindexed ${filesReindexed} files after commit`,
            durationMs: 0,
          };
        } catch (err: any) {
          return {
            hookId: "auto-reindex",
            event: "PostToolUse",
            success: false,
            error: `Reindex failed: ${err.message}`,
            durationMs: 0,
          };
        }
      },
    },
  ];
}
