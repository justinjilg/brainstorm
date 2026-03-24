/**
 * Insight system — normalizes the model's teaching annotations into
 * a consistent format for TUI rendering.
 *
 * The model is instructed to emit insights via the system prompt.
 * This module provides the prompt section and a lightweight post-processor
 * that ensures consistent formatting (★ Insight: prefix).
 */

/** The system prompt section that instructs the model to teach as it works. */
export const INSIGHT_PROMPT_SECTION = `# Teaching

After completing a significant action (fixing a bug, making an architecture decision, choosing between approaches), briefly share ONE non-obvious insight about your choice. Format as:

★ Insight: [your observation in 2-3 sentences]

Guidelines:
- Only for non-obvious choices — skip trivial actions like reading a file or running a command.
- Focus on WHY you made a choice, not WHAT you did.
- One insight per significant action, not per response.
- Keep it genuinely useful — not filler like "TypeScript is great for type safety."`;

/**
 * Normalize insight markers in streamed text.
 * Catches common model variations and standardizes to "★ Insight:".
 */
export function normalizeInsightMarkers(text: string): string {
  // Standardize common variations the model might produce
  return text
    .replace(/\*\*Insight\*\*:/g, '★ Insight:')
    .replace(/💡\s*Insight:/g, '★ Insight:')
    .replace(/🔍\s*Insight:/g, '★ Insight:')
    .replace(/\*\*★ Insight:\*\*/g, '★ Insight:');
}
