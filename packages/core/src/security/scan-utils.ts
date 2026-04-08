/**
 * Shared scanning utilities — used by both policy-validator and markdown-scanner.
 * Consolidates the duplicated regex scanning loop and finding accumulation.
 */

export interface ScanRule<F> {
  pattern: RegExp;
  /** Called when a match is found. Returns the finding to accumulate. */
  toFinding: (match: RegExpExecArray, content: string) => F;
  /** Max matches per rule to prevent flooding (default: 10). */
  maxMatches?: number;
}

/**
 * Run a list of regex rules against content and accumulate findings.
 * Handles global/non-global patterns, lastIndex reset, and match limits.
 */
export function runScanRules<F>(content: string, rules: ScanRule<F>[]): F[] {
  const findings: F[] = [];
  const DEFAULT_MAX = 10;

  for (const rule of rules) {
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    const limit = rule.maxMatches ?? DEFAULT_MAX;
    let matchCount = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      findings.push(rule.toFinding(match, content));
      matchCount++;

      if (matchCount >= limit) break;
      if (!rule.pattern.global) break;
    }
  }

  return findings;
}

/**
 * Strip control characters from a string for safe logging.
 */
export function sanitizeForLog(text: string, maxLen = 80): string {
  return text.slice(0, maxLen).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}
