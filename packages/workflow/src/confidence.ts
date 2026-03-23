import type { Artifact, WorkflowStepDef } from '@brainstorm/shared';

export type EscalationAction = 'continue' | 'retry' | 'pause';

/**
 * Extract confidence from an artifact.
 * Priority: structured JSON field > heuristic text scan > default.
 */
export function extractConfidence(artifact: Artifact): number {
  // 1. Structured JSON output with confidence field
  if (artifact.contentType === 'json') {
    try {
      const parsed = JSON.parse(artifact.content);
      if (typeof parsed.confidence === 'number') {
        return Math.max(0, Math.min(1, parsed.confidence));
      }
    } catch { /* not valid JSON */ }
  }

  // 2. Heuristic scan for confidence language
  const text = artifact.content.toLowerCase();

  if (text.includes('i am not sure') || text.includes("i'm uncertain") || text.includes('might not be correct') || text.includes('i am unsure')) {
    return 0.4;
  }
  if (text.includes("i'm fairly confident") || text.includes('should work') || text.includes('likely correct')) {
    return 0.7;
  }
  if (text.includes('i am confident') || text.includes('this will work') || text.includes('i am certain')) {
    return 0.9;
  }

  // 3. Default moderate confidence
  return 0.6;
}

/**
 * Determine escalation action based on confidence vs threshold.
 */
export function determineEscalation(
  confidence: number,
  threshold: number,
  canRetry: boolean,
): EscalationAction {
  if (confidence >= threshold) return 'continue';

  const deficit = threshold - confidence;

  // Large deficit → pause for user decision
  if (deficit > 0.3) return 'pause';

  // Small deficit and can retry → retry with same or better model
  if (deficit > 0.1 && canRetry) return 'retry';

  // Marginal → continue with warning
  return 'continue';
}

/**
 * Check if a review artifact indicates rejection.
 */
export function isReviewApproved(artifact: Artifact): boolean {
  // Try structured JSON first
  try {
    const parsed = JSON.parse(artifact.content);
    if (typeof parsed.approved === 'boolean') return parsed.approved;
  } catch { /* not JSON */ }

  // Heuristic fallback
  const text = artifact.content.toLowerCase();
  if (text.includes('approved') && !text.includes('not approved')) return true;
  if (text.includes('lgtm') || text.includes('looks good')) return true;
  if (text.includes('rejected') || text.includes('needs changes') || text.includes('not approved')) return false;
  if (text.includes('issues found') || text.includes('critical')) return false;

  return true; // default to approved if unclear
}
