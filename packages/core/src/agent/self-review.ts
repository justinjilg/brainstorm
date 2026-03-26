/**
 * Model Self-Evaluation — run a cheap reviewer after file writes.
 * Catches obvious mistakes (missing imports, wrong file, logic errors)
 * before the user sees the response.
 *
 * Uses a separate model call (Haiku-class) to review the changes.
 * Configurable: off by default for speed, enabled in config.
 */

export interface SelfReviewResult {
  issues: string[];
  passed: boolean;
  reviewCost: number;
}

export interface SelfReviewOptions {
  filesWritten: Array<{ path: string; content: string }>;
  originalRequest: string;
  modelResponse: string;
}

/**
 * Build the self-review prompt for a cheap model to evaluate.
 * Returns null if there's nothing to review (no file writes).
 */
export function buildSelfReviewPrompt(options: SelfReviewOptions): string | null {
  if (options.filesWritten.length === 0) return null;

  const fileSection = options.filesWritten
    .map((f) => {
      const preview = f.content.length > 2000
        ? f.content.slice(0, 1000) + '\n...\n' + f.content.slice(-1000)
        : f.content;
      return `--- ${f.path} ---\n${preview}`;
    })
    .join('\n\n');

  return `You are reviewing code that was just written by an AI assistant.

USER REQUEST: ${options.originalRequest.slice(0, 500)}

FILES WRITTEN:
${fileSection}

ASSISTANT EXPLANATION: ${options.modelResponse.slice(0, 500)}

Check for these issues ONLY (be brief, list only real problems):
1. Missing imports that would cause runtime errors
2. Wrong file path (file doesn't match what was asked)
3. Obvious logic errors (infinite loops, wrong variable names)
4. Syntax errors that would prevent compilation

If everything looks correct, respond with exactly: PASS
Otherwise, list each issue on its own line starting with "ISSUE: "`;
}

/**
 * Parse the self-review response into structured results.
 */
export function parseSelfReviewResponse(response: string): SelfReviewResult {
  const trimmed = response.trim();

  if (trimmed === 'PASS' || trimmed.startsWith('PASS')) {
    return { issues: [], passed: true, reviewCost: 0 };
  }

  const issues = trimmed
    .split('\n')
    .filter((line) => line.startsWith('ISSUE:'))
    .map((line) => line.replace('ISSUE:', '').trim());

  return {
    issues,
    passed: issues.length === 0,
    reviewCost: 0,
  };
}
