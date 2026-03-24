import { streamText } from 'ai';
import type { ConversationMessage } from './manager.js';

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
export function needsCompaction(messages: ConversationMessage[], contextWindow: number): boolean {
  const tokens = estimateTokenCount(messages);
  return tokens > contextWindow * 0.8;
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
  },
): Promise<{ messages: ConversationMessage[]; compacted: boolean; summaryCost: number }> {
  const { contextWindow, keepRecent = 5, summarizeModel } = options;

  if (!needsCompaction(messages, contextWindow)) {
    return { messages, compacted: false, summaryCost: 0 };
  }

  // Separate system message (if any)
  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
  const conversationMsgs = systemMsg ? messages.slice(1) : messages;

  // Keep the most recent messages
  const recentStart = Math.max(0, conversationMsgs.length - keepRecent);
  const oldMessages = conversationMsgs.slice(0, recentStart);
  const recentMessages = conversationMsgs.slice(recentStart);

  if (oldMessages.length === 0) {
    return { messages, compacted: false, summaryCost: 0 };
  }

  let summary: string;
  let summaryCost = 0;

  if (summarizeModel) {
    // Use an LLM to summarize the old messages
    try {
      const oldText = oldMessages
        .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
        .join('\n\n');

      const result = streamText({
        model: summarizeModel,
        system: 'Summarize this conversation concisely. Preserve: key decisions, file paths mentioned, errors encountered, and current task context. Be brief.',
        messages: [{ role: 'user' as const, content: oldText }],
      });

      let summaryText = '';
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          summaryText += (part as any).text ?? (part as any).delta ?? '';
        }
      }

      // Capture summarization cost from usage
      try {
        const usage = await result.usage;
        if (usage) {
          const inputTokens = (usage as any).inputTokens ?? 0;
          const outputTokens = (usage as any).outputTokens ?? 0;
          summaryCost = (inputTokens + outputTokens) * 0.000001; // rough estimate
        }
      } catch { /* usage not available — non-fatal */ }

      summary = summaryText || fallbackSummary(oldMessages);
    } catch {
      summary = fallbackSummary(oldMessages);
    }
  } else {
    summary = fallbackSummary(oldMessages);
  }

  // Build compacted message list
  const compacted: ConversationMessage[] = [];
  if (systemMsg) compacted.push(systemMsg);
  compacted.push({
    role: 'system',
    content: `[Context compacted — ${oldMessages.length} messages summarized]\n\n${summary}`,
  });
  compacted.push(...recentMessages);

  return { messages: compacted, compacted: true, summaryCost };
}

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
    parts.push(`Files discussed: ${Array.from(filePaths).slice(0, 15).join(', ')}`);
  }

  // Extract the last user request before compaction
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser) {
    parts.push(`Last topic: ${lastUser.content.slice(0, 200)}`);
  }

  return parts.join('\n');
}
