import type { Artifact, WorkflowStepDef, ModelEntry } from '@brainstorm/shared';

export type EscalationAction = 'continue' | 'retry' | 'pause';

export interface ModelEscalation {
  action: EscalationAction;
  /** If action is 'retry', the model to escalate to (higher capability). */
  escalateToModelId?: string;
  /** Reason for escalation. */
  reason: string;
}

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

/**
 * Determine cross-model escalation when a step's confidence is too low.
 *
 * Given the current model and available models, find a more capable model
 * to retry the step on. Uses quality tier as the primary escalation axis.
 */
export function determineModelEscalation(
  confidence: number,
  threshold: number,
  currentModel: ModelEntry,
  availableModels: ModelEntry[],
  canRetry: boolean,
): ModelEscalation {
  const action = determineEscalation(confidence, threshold, canRetry);

  if (action !== 'retry') {
    return { action, reason: action === 'continue'
      ? `Confidence ${(confidence * 100).toFixed(0)}% meets threshold`
      : `Confidence ${(confidence * 100).toFixed(0)}% too low — pausing for user decision` };
  }

  // Find a more capable model (higher quality tier)
  const betterModels = availableModels
    .filter((m) =>
      m.status === 'available' &&
      m.id !== currentModel.id &&
      m.capabilities.qualityTier < currentModel.capabilities.qualityTier, // lower tier = higher quality
    )
    .sort((a, b) => a.capabilities.qualityTier - b.capabilities.qualityTier);

  if (betterModels.length === 0) {
    // Already on the best available model — retry with same model
    return {
      action: 'retry',
      reason: `Confidence ${(confidence * 100).toFixed(0)}% below threshold — retrying on same model (no higher-quality model available)`,
    };
  }

  const escalateTarget = betterModels[0];
  return {
    action: 'retry',
    escalateToModelId: escalateTarget.id,
    reason: `Confidence ${(confidence * 100).toFixed(0)}% below threshold — escalating from ${currentModel.name} to ${escalateTarget.name}`,
  };
}
