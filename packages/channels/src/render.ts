/**
 * Render an agent-loop event stream into a channel-ready final message, plus
 * Slack mrkdwn conversion helpers.
 *
 * The coordinator buffers every {@link AgentEvent} from a run, then calls
 * {@link renderFinal} to collapse them into the finished markdown, the list of
 * tools that ran, and the total cost — the exact triple {@link OutboundSink}
 * .finalize needs.
 */

import type { AgentEvent } from "@brainst0rm/shared";

/** Slack's hard per-message text ceiling is ~40k chars; stay under it. */
const DEFAULT_SLACK_MAX = 39000;

export interface RenderResult {
  markdown: string;
  toolCalls: string[];
  cost: number;
}

/**
 * Collapse a run's event stream into its final markdown, the tools that ran,
 * and the total cost. Text deltas are concatenated in order; tool names come
 * from tool-call-start events; cost comes from the terminal done event.
 */
export function renderFinal(events: AgentEvent[]): RenderResult {
  let markdown = "";
  const toolCalls: string[] = [];
  let cost = 0;

  for (const event of events) {
    switch (event.type) {
      case "text-delta":
        markdown += event.delta;
        break;
      case "tool-call-start":
        toolCalls.push(event.toolName);
        break;
      case "done":
        cost = event.totalCost;
        break;
    }
  }

  return { markdown, toolCalls, cost };
}

/**
 * Convert a subset of Markdown to Slack mrkdwn:
 * - `**bold**` → `*bold*`
 * - `[text](url)` → `<url|text>`
 * - headings (`# ...`) → `*...*` bold lines
 * - code fences and inline code are preserved verbatim (never rewritten).
 */
export function markdownToMrkdwn(md: string): string {
  // Split off fenced blocks and inline code so their contents are left alone,
  // then transform only the plain-text gaps between them.
  const codePattern = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let result = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = codePattern.exec(md)) !== null) {
    result += transformProse(md.slice(last, match.index));
    result += match[0];
    last = match.index + match[0].length;
  }
  result += transformProse(md.slice(last));
  return result;
}

/** Apply mrkdwn transforms to a non-code text segment. */
function transformProse(text: string): string {
  // Headings → bold lines (strip leading #'s, must be at line start). Strip any
  // inner `**bold**` markers first so `# **Title**` becomes `*Title*` rather
  // than a doubled `**Title**` once the bold pass runs.
  let out = text.replace(
    /^#{1,6}[ \t]+(.+?)[ \t]*$/gm,
    (_m, title: string) => "*" + title.replace(/\*\*/g, "") + "*",
  );
  // Links [text](url) → <url|text>. Run before bold so bracketed text with
  // asterisks is handled inside the link first.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>");
  // Bold **text** → *text*.
  out = out.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  return out;
}

/**
 * Truncate text to Slack's message ceiling, appending an ellipsis marker when
 * the input exceeds `max`.
 */
export function truncateForSlack(
  text: string,
  max = DEFAULT_SLACK_MAX,
): string {
  if (text.length <= max) return text;
  const suffix = "… (truncated)";
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}
