/**
 * Trajectory Reduction — AgentDiet-inspired context optimization.
 *
 * After each turn, classifies conversation messages as:
 *   - active: still relevant to the current task
 *   - expired: superseded by later information
 *   - redundant: duplicate of another message
 *
 * Removes expired/redundant messages BEFORE token-based compaction,
 * achieving 40-60% token savings without quality loss.
 *
 * Heuristic-first: no LLM call needed for most reductions.
 * Inspired by ByteDance Trae Agent's AgentDiet technique.
 */

import type { ConversationMessage } from "./manager.js";

export type MessageStatus = "active" | "expired" | "redundant";

export interface ReductionResult {
  /** Messages after reduction. */
  reduced: ConversationMessage[];
  /** Number of messages removed. */
  removedCount: number;
  /** Estimated tokens saved. */
  estimatedTokensSaved: number;
  /** Breakdown of removal reasons. */
  reasons: Record<string, number>;
}

/**
 * Reduce a conversation trajectory by removing expired and redundant messages.
 *
 * @param messages - Full conversation history
 * @param currentTurn - Current turn number (for age-based expiry)
 * @returns Reduced conversation with removal stats
 */
export function reduceTrajectory(
  messages: ConversationMessage[],
  currentTurn: number,
): ReductionResult {
  const reasons: Record<string, number> = {};
  const writtenFiles = new Set<string>();
  const readFiles = new Map<string, number>(); // file → last read turn
  const seenGrepPatterns = new Set<string>();
  let gitStatusTurn = -1;

  // First pass: collect file write history, last read positions, and git status
  const lastReadTurn = new Map<string, number>(); // file → index of LAST read
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = typeof msg.content === "string" ? msg.content : "";

    // Track file writes
    const writeMatch = content.match(
      /(?:file_write|file_edit|multi_edit|batch_edit).*?(?:path|file)['":\s]+([^\s'"]+)/i,
    );
    if (writeMatch) {
      writtenFiles.add(writeMatch[1]);
    }

    // Track file reads — record the last index per file
    const readMatch = content.match(
      /file_read.*?(?:path|file)['":\s]+([^\s'"]+)/i,
    );
    if (readMatch) {
      lastReadTurn.set(readMatch[1], i);
    }

    // Track git status positions
    if (content.includes("git_status") && msg.role === "assistant") {
      gitStatusTurn = i;
    }
  }

  // Second pass: classify each message
  const statuses: MessageStatus[] = messages.map((msg, i) => {
    const content = typeof msg.content === "string" ? msg.content : "";
    const turn = i; // Approximate turn from message index

    // Never remove system messages, user messages, or recent messages (last 4)
    if (msg.role === "system" || msg.role === "user") return "active";
    if (i >= messages.length - 4) return "active";

    // Never remove messages with [keep] prefix
    if (content.startsWith("[keep]")) return "active";

    // Rule 1: File reads older than 5 turns, where file was subsequently written
    const readMatch = content.match(
      /file_read.*?(?:path|file)['":\s]+([^\s'"]+)/i,
    );
    if (readMatch && writtenFiles.has(readMatch[1]) && currentTurn - turn > 5) {
      reasons["stale-file-read"] = (reasons["stale-file-read"] ?? 0) + 1;
      return "expired";
    }

    // Rule 2: Duplicate file reads — keep only the last read per file
    if (readMatch) {
      const filePath = readMatch[1];
      if (lastReadTurn.get(filePath) !== i) {
        // A later read of the same file exists — this one is redundant
        reasons["duplicate-file-read"] =
          (reasons["duplicate-file-read"] ?? 0) + 1;
        return "redundant";
      }
    }

    // Rule 3: Old grep results (> 3 turns old)
    const grepMatch = content.match(/grep.*?pattern['":\s]+([^\s'"]+)/i);
    if (grepMatch && currentTurn - turn > 3) {
      const pattern = grepMatch[1];
      if (seenGrepPatterns.has(pattern)) {
        reasons["duplicate-grep"] = (reasons["duplicate-grep"] ?? 0) + 1;
        return "redundant";
      }
      seenGrepPatterns.add(pattern);

      // Old grep results that weren't followed by action
      if (currentTurn - turn > 5) {
        reasons["stale-grep"] = (reasons["stale-grep"] ?? 0) + 1;
        return "expired";
      }
    }

    // Rule 4: Superseded git status (only keep the most recent)
    if (
      content.includes("git_status") &&
      msg.role === "assistant" &&
      turn < gitStatusTurn
    ) {
      reasons["superseded-git-status"] =
        (reasons["superseded-git-status"] ?? 0) + 1;
      return "expired";
    }

    // Rule 5: Old list_dir results (> 5 turns old)
    if (
      content.includes("list_dir") &&
      msg.role === "assistant" &&
      currentTurn - turn > 5
    ) {
      reasons["stale-list-dir"] = (reasons["stale-list-dir"] ?? 0) + 1;
      return "expired";
    }

    // Rule 6: Tool error messages older than 3 turns (errors are transient)
    if (
      msg.role === "assistant" &&
      content.includes('"ok":false') &&
      currentTurn - turn > 3
    ) {
      reasons["old-tool-error"] = (reasons["old-tool-error"] ?? 0) + 1;
      return "expired";
    }

    return "active";
  });

  // Build reduced message list
  const reduced = messages.filter((_, i) => statuses[i] === "active");
  const removedCount = messages.length - reduced.length;

  // Estimate tokens saved (~100 tokens per removed message on average)
  const estimatedTokensSaved = removedCount * 100;

  return {
    reduced,
    removedCount,
    estimatedTokensSaved,
    reasons,
  };
}

/**
 * Format reduction stats for turn context injection.
 */
export function formatReductionStats(result: ReductionResult): string {
  if (result.removedCount === 0) return "";

  const reasonSummary = Object.entries(result.reasons)
    .map(([reason, count]) => `${reason}(${count})`)
    .join(", ");

  return `[Trajectory reduced: ${result.removedCount} messages removed (~${result.estimatedTokensSaved} tokens saved). Reasons: ${reasonSummary}]`;
}
