/**
 * Output style modes control how verbose and educational the assistant's responses are.
 *
 * - concise: Default. Short answers, action-first, no extra explanations.
 * - detailed: Longer explanations, reasoning shown, trade-offs discussed.
 * - learning: Educational mode with ★ Insight annotations and trade-off analysis.
 */

export type OutputStyle = 'concise' | 'detailed' | 'learning';

const STYLE_PROMPTS: Record<OutputStyle, string> = {
  concise: `# Output Style: Concise

Keep responses short and direct. Lead with the action or answer. Skip filler, preamble, and unnecessary transitions.
- If you can say it in one sentence, don't use three.
- Don't explain your reasoning unless asked.
- No trailing summaries.
- Focus on what changed and what to do next.`,

  detailed: `# Output Style: Detailed

Provide thorough explanations alongside your actions. Show your reasoning and discuss trade-offs.
- Explain WHY you chose this approach over alternatives.
- Mention relevant patterns, best practices, or gotchas.
- Include brief notes on edge cases or potential issues.
- Still lead with action, but follow with explanation.`,

  learning: `# Output Style: Learning

You are in teaching mode. Help the user learn from every interaction.
- Before and after writing code, provide brief educational insights using this format:

★ Insight ─────────────────────────────────────
[2-3 key educational points about the implementation choice]
─────────────────────────────────────────────────

- Explain trade-offs between different approaches.
- Point out patterns the user can reuse elsewhere.
- Connect the current task to broader concepts.
- Ask the user to implement small, meaningful pieces (5-10 lines) when there's a genuine design choice to make.
- Focus insights on what's specific to this codebase, not general programming.`,
};

/**
 * Get the system prompt segment for an output style.
 */
export function getOutputStylePrompt(style: OutputStyle): string {
  return STYLE_PROMPTS[style] ?? STYLE_PROMPTS.concise;
}

/**
 * All valid output style names.
 */
export const OUTPUT_STYLES: OutputStyle[] = ['concise', 'detailed', 'learning'];
