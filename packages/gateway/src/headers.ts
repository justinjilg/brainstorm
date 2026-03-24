import type { GatewayFeedback } from './types.js';

/**
 * Parse BrainstormRouter response headers into structured feedback.
 * These headers are returned on every completion request.
 */
export function parseGatewayHeaders(headers: Record<string, string>): GatewayFeedback {
  const feedback: GatewayFeedback = {};

  const budgetRemaining = headers['x-budget-remaining'] ?? headers['x-br-budget-remaining'];
  if (budgetRemaining) feedback.budgetRemaining = parseFloat(budgetRemaining);

  const guardianStatus = headers['x-br-guardian-status'] ?? headers['x-br-guardrail-status'];
  if (guardianStatus) feedback.guardianStatus = guardianStatus;

  const estimatedCost = headers['x-br-estimated-cost'];
  if (estimatedCost) feedback.actualCost = parseFloat(estimatedCost);

  const requestId = headers['x-request-id'];
  if (requestId) feedback.requestId = requestId;

  const selectedModel = headers['x-br-model-selected'];
  if (selectedModel) feedback.selectedModel = selectedModel;

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
  }
  if (feedback.selectedModel) {
    parts.push(`Model: ${feedback.selectedModel}`);
  }

  return parts.length > 0 ? parts.join(' | ') : '';
}
