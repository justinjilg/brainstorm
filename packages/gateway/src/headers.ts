import type { GatewayFeedback } from './types.js';

/**
 * Parse BrainstormRouter response headers into structured feedback.
 * Accepts both fetch Headers objects and plain Record<string, string>.
 */
export function parseGatewayHeaders(headers: Headers | Record<string, string>): GatewayFeedback {
  const get = (key: string): string | null =>
    headers instanceof Headers ? headers.get(key) : (headers[key] ?? null);

  const feedback: GatewayFeedback = {};

  const safeFloat = (val: string | null): number | undefined => {
    if (!val) return undefined;
    const parsed = parseFloat(val);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  feedback.guardianStatus = get('x-br-guardian-status') ?? undefined;
  feedback.estimatedCost = safeFloat(get('x-br-estimated-cost'));
  feedback.actualCost = safeFloat(get('x-br-actual-cost'));
  feedback.efficiency = safeFloat(get('x-br-efficiency'));
  feedback.overheadMs = safeFloat(get('x-br-guardian-overhead-ms'));
  feedback.cacheHit = get('x-br-cache') ?? undefined;
  feedback.budgetRemaining = safeFloat(get('x-budget-remaining') ?? get('x-br-budget-remaining'));
  feedback.selectedModel = get('x-br-routed-model') ?? undefined;
  feedback.selectionMethod = get('x-br-selection-method') ?? undefined;
  feedback.complexityScore = safeFloat(get('x-br-complexity-score'));
  feedback.requestId = get('x-request-id') ?? undefined;

  // Strip undefined values
  for (const key of Object.keys(feedback) as (keyof GatewayFeedback)[]) {
    if (feedback[key] === undefined) delete feedback[key];
  }

  return feedback;
}

/**
 * Format gateway feedback for display in the CLI.
 */
export function formatGatewayFeedback(feedback: GatewayFeedback): string {
  const parts: string[] = [];

  if (feedback.budgetRemaining !== undefined) {
    parts.push(`Budget: $${feedback.budgetRemaining.toFixed(2)}`);
  }
  if (feedback.guardianStatus) {
    parts.push(`Guardian: ${feedback.guardianStatus}`);
  }
  if (feedback.actualCost !== undefined) {
    parts.push(`Cost: $${feedback.actualCost.toFixed(4)}`);
  } else if (feedback.estimatedCost !== undefined) {
    parts.push(`Est: $${feedback.estimatedCost.toFixed(4)}`);
  }
  if (feedback.selectedModel) {
    parts.push(`Model: ${feedback.selectedModel}`);
  }
  if (feedback.cacheHit) {
    parts.push(`Cache: ${feedback.cacheHit}`);
  }

  return parts.length > 0 ? parts.join(' | ') : '';
}
