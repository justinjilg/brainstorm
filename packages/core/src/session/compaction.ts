import { streamText } from "ai";
import type { ConversationMessage } from "./manager.js";
import { formatScratchpadContext } from "@brainstorm/tools";
import { reduceTrajectory } from "./trajectory-reducer.js";

// ── Compaction Gate ──────────────────────────────────────────────

let _toolsInFlight = 0;

/** Increment the in-flight tool counter. Call before each tool execution. */
export function enterToolExecution(): void {
  _toolsInFlight++;
}

/** Decrement the in-flight tool counter. Call after each tool completes. */
export function exitToolExecution(): void {
  _toolsInFlight = Math.max(0, _toolsInFlight - 1);
}

/** Returns true if tools are currently executing (compaction should be deferred). */
export function isToolInFlight(): boolean {
  return _toolsInFlight > 0;
}

/**
 * Estimate token count for a list of messages.
 * Uses ~4 chars per token as a rough heuristic (good enough for budget checks).
 */
export function estimateTokenCount(messages: ConversationMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 20; // 20 chars overhead for role + formatting
  }
  return Math.ceil(chars / 4);
}

/**
 * Check if compaction is needed based on token count vs context window.
 * Triggers at 80% of the model's context window.
 */
export function needsCompaction(
  messages: ConversationMessage[],
  contextWindow: number,
): boolean {
  // Defer compaction while tools are executing to avoid corrupting in-flight state
  if (isToolInFlight()) return false;
  const tokens = estimateTokenCount(messages);
  return tokens > contextWindow * 0.8;
}

/** Get context usage as a percentage (0-100). Useful for pre-compaction warnings. */
export function getContextPercent(
  messages: ConversationMessage[],
  contextWindow: number,
): number {
  const tokens = estimateTokenCount(messages);
  return Math.round((tokens / contextWindow) * 100);
}

/**
 * Compact conversation history by summarizing old messages.
 *
 * Strategy:
 * 1. Keep system prompt (first message if role=system) intact
 * 2. Keep the last `keepRecent` messages intact
 * 3. Summarize everything in between using the provided model
 * 4. Return the compacted message list
 *
 * If no model is available for summarization, falls back to simple truncation.
 */
export async function compactContext(
  messages: ConversationMessage[],
  options: {
    contextWindow: number;
    keepRecent?: number;
    summarizeModel?: any; // AI SDK model instance for summarization
    pricing?: { inputPer1MTokens: number; outputPer1MTokens: number };
  },
): Promise<{
  messages: ConversationMessage[];
  compacted: boolean;
  summaryCost: number;
}> {
  const { contextWindow, keepRecent = 5, summarizeModel } = options;

  // Phase 1: Trajectory reduction — remove expired/redundant messages before compaction
  const turnEstimate = messages.length; // use message count as turn proxy for age-based expiry
  const reduction = reduceTrajectory(messages, turnEstimate);
  const workingMessages =
    reduction.removedCount > 0 ? reduction.reduced : messages;

  if (!needsCompaction(workingMessages, contextWindow)) {
    return {
      messages: workingMessages,
      compacted: reduction.removedCount > 0,
      summaryCost: 0,
    };
  }

  // Separate system message (if any)
  const systemMsg =
    workingMessages[0]?.role === "system" ? workingMessages[0] : null;
  const conversationMsgs = systemMsg
    ? workingMessages.slice(1)
    : workingMessages;

  // Keep the most recent messages
  const recentStart = Math.max(0, conversationMsgs.length - keepRecent);
  const oldMessages = conversationMsgs.slice(0, recentStart);
  const recentMessages = conversationMsgs.slice(recentStart);

  if (oldMessages.length === 0) {
    return {
      messages: workingMessages,
      compacted: reduction.removedCount > 0,
      summaryCost: 0,
    };
  }

  // Classify messages into keep/summarize/drop buckets
  const kept: ConversationMessage[] = [];
  const toSummarize: ConversationMessage[] = [];
  let dropped = 0;

  for (let i = 0; i < oldMessages.length; i++) {
    const classification = classifyMessage(oldMessages[i], oldMessages, i);
    if (classification === "keep") {
      kept.push(oldMessages[i]);
    } else if (classification === "summarize") {
      toSummarize.push(oldMessages[i]);
    } else {
      dropped++;
    }
  }

  let summary: string;
  let summaryCost = 0;

  if (summarizeModel && toSummarize.length > 0) {
    // Use an LLM to summarize only the 'summarize' bucket
    try {
      const oldText = toSummarize
        .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
        .join("\n\n");

      const result = streamText({
        model: summarizeModel,
        system:
          "Summarize this conversation concisely. Preserve: key decisions, file paths mentioned, errors encountered, and current task context. Be brief.",
        messages: [{ role: "user" as const, content: oldText }],
        abortSignal: AbortSignal.timeout(30_000),
      });

      let summaryText = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          summaryText += (part as any).text ?? (part as any).delta ?? "";
        }
      }

      // Capture summarization cost from usage
      try {
        const usage = await result.usage;
        if (usage) {
          const inputTokens = (usage as any).inputTokens ?? 0;
          const outputTokens = (usage as any).outputTokens ?? 0;
          const p = options.pricing;
          summaryCost = p
            ? (inputTokens / 1_000_000) * p.inputPer1MTokens +
              (outputTokens / 1_000_000) * p.outputPer1MTokens
            : (inputTokens + outputTokens) * 0.000001;
        }
      } catch {
        /* usage not available — non-fatal */
      }

      summary = summaryText || fallbackSummary(toSummarize);
    } catch {
      summary = fallbackSummary(toSummarize);
    }
  } else {
    summary = toSummarize.length > 0 ? fallbackSummary(toSummarize) : "";
  }

  // Build compacted message list: system + kept messages + summary + recent
  const compacted: ConversationMessage[] = [];
  if (systemMsg) compacted.push(systemMsg);

  // Inject kept messages as a structured block
  if (kept.length > 0) {
    const keptContent = kept
      .map((m) => `[${m.role}]: ${m.content.slice(0, 800)}`)
      .join("\n\n");
    compacted.push({
      role: "system",
      content: `[Preserved context — ${kept.length} critical messages retained, ${dropped} dropped]\n\n${keptContent}`,
    });
  }

  if (summary) {
    compacted.push({
      role: "system",
      content: `[Summarized context — ${toSummarize.length} messages condensed]\n\n${summary}`,
    });
  }

  // Post-compaction summary — tell the agent what happened
  const summaryParts = [
    `Compacted: ${oldMessages.length} old messages processed.`,
  ];
  if (kept.length > 0)
    summaryParts.push(`Preserved: ${kept.length} critical messages.`);
  if (toSummarize.length > 0)
    summaryParts.push(`Summarized: ${toSummarize.length} messages.`);
  if (dropped > 0) summaryParts.push(`Dropped: ${dropped} redundant messages.`);
  summaryParts.push(`Retained: ${recentMessages.length} recent messages.`);
  compacted.push({
    role: "system",
    content: `[Compaction summary] ${summaryParts.join(" ")}`,
  });

  // Inject scratchpad entries so they survive compaction
  const scratchpadCtx = formatScratchpadContext();
  if (scratchpadCtx) {
    compacted.push({ role: "system", content: scratchpadCtx });
  }

  compacted.push(...recentMessages);

  return { messages: compacted, compacted: true, summaryCost };
}

// ── Message Classification ────────────────────────────────────────

/**
 * Classify a message for compaction: keep, summarize, or drop.
 *
 * - keep: file edits, error messages, user decisions, write-related content
 * - summarize: long assistant explanations
 * - drop: short system/routing messages, context that's been superseded
 */
function classifyMessage(
  msg: ConversationMessage,
  allMessages: ConversationMessage[],
  index: number,
): "keep" | "summarize" | "drop" {
  // Always keep user messages (they contain decisions and intent)
  if (msg.role === "user") return "keep";

  const content = msg.content;

  // [keep] prefix marks messages as compaction-resistant
  if (content.startsWith("[keep]") || content.startsWith("[KEEP]"))
    return "keep";

  // Preserve memory-injected context (survives compaction by design)
  if (
    content.includes("[Memory]") ||
    content.includes("[memory]") ||
    content.includes("Memory context:")
  )
    return "keep";

  // Preserve loop warnings (critical for preventing repeated mistakes)
  if (
    content.includes("[Loop warning]") ||
    content.includes("loop-warning") ||
    content.includes("Loop detected")
  )
    return "keep";

  // Keep error messages
  if (
    content.includes("Error:") ||
    content.includes("error:") ||
    content.includes("FAIL")
  ) {
    return "keep";
  }

  // Keep messages that mention file modifications (content-based heuristic)
  if (WRITE_INDICATORS.some((p) => content.includes(p))) {
    return "keep";
  }

  // Drop compaction summary messages from prior compactions
  if (
    content.startsWith("[Context compacted") ||
    content.startsWith("[Preserved context") ||
    content.startsWith("[Summarized context")
  ) {
    return "drop";
  }

  // Long assistant messages get summarized
  if (msg.role === "assistant" && content.length > 2000) {
    return "summarize";
  }

  // Short assistant messages — keep
  if (msg.role === "assistant") return "keep";

  // Default: summarize
  return "summarize";
}

/** Content patterns indicating file write/mutation activity. */
const WRITE_INDICATORS = [
  "wrote to",
  "edited",
  "modified",
  "created file",
  "committed",
  "file_write",
  "file_edit",
  "git_commit",
  "git commit",
  "Successfully",
  "saved",
  "Updated",
];

/**
 * Fallback summary when no model is available.
 * Extracts key signals from old messages without LLM.
 */
function fallbackSummary(messages: ConversationMessage[]): string {
  const parts: string[] = [];
  parts.push(`Previous conversation: ${messages.length} messages.`);

  // Extract file paths mentioned
  const filePaths = new Set<string>();
  for (const m of messages) {
    const paths = m.content.match(/[\w./]+\.\w{1,5}/g);
    if (paths) paths.forEach((p) => filePaths.add(p));
  }
  if (filePaths.size > 0) {
    parts.push(
      `Files discussed: ${Array.from(filePaths).slice(0, 15).join(", ")}`,
    );
  }

  // Extract the last user request before compaction
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser) {
    parts.push(`Last topic: ${lastUser.content.slice(0, 200)}`);
  }

  return parts.join("\n");
}
