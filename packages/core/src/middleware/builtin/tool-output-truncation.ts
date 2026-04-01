import type { AgentMiddleware, MiddlewareToolResult } from "../types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("tool-truncation");

/**
 * Default maximum characters for a single tool output before truncation.
 * 8K chars ≈ 2K tokens — enough for most useful output without bloating context.
 */
const DEFAULT_MAX_CHARS = 8_000;

/** Tools whose output should never be truncated (e.g., file_write confirmations are small). */
const NEVER_TRUNCATE = new Set([
  "file_write",
  "file_edit",
  "git_commit",
  "git_push",
  "subagent",
  "task_create",
  "task_update",
]);

/** Tools that produce large output and benefit most from truncation. */
const AGGRESSIVE_TRUNCATE = new Set([
  "shell",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
]);

/**
 * Tier 1 Compaction — Tool Output Truncation Middleware
 *
 * Prevents oversized tool outputs from bloating the context window.
 * Runs in afterToolResult, before the output reaches the conversation history.
 *
 * Strategy:
 * - Never truncate small outputs or critical tools (file_write, git_commit)
 * - Aggressive truncation for high-volume tools (grep, glob, shell)
 * - Standard truncation for everything else
 * - Preserves the first and last portions of truncated output for context
 */
export function createToolOutputTruncationMiddleware(
  maxChars = DEFAULT_MAX_CHARS,
): AgentMiddleware {
  let totalTruncated = 0;
  let totalCharsSaved = 0;

  return {
    name: "tool-output-truncation",

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      if (NEVER_TRUNCATE.has(result.name)) return;

      const output =
        typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output);

      if (!output) return;

      const limit = AGGRESSIVE_TRUNCATE.has(result.name)
        ? Math.floor(maxChars * 0.6) // 60% of max for high-volume tools
        : maxChars;

      if (output.length <= limit) return;

      // Keep the first 70% and last 20% of the budget, with a truncation notice in between
      const headBudget = Math.floor(limit * 0.7);
      const tailBudget = Math.floor(limit * 0.2);
      const originalLines = output.split("\n").length;
      const head = output.slice(0, headBudget);
      const tail = output.slice(-tailBudget);
      const charsDropped = output.length - headBudget - tailBudget;

      const truncated = [
        head,
        `\n\n[... truncated ${charsDropped.toLocaleString()} chars (${originalLines} lines total) ...]\n\n`,
        tail,
      ].join("");

      totalTruncated++;
      totalCharsSaved += output.length - truncated.length;

      if (totalTruncated % 10 === 1) {
        log.debug(
          {
            tool: result.name,
            originalLen: output.length,
            truncatedLen: truncated.length,
            totalSaved: totalCharsSaved,
          },
          "tool output truncated (tier 1 compaction)",
        );
      }

      return {
        ...result,
        output: truncated,
      };
    },
  };
}
