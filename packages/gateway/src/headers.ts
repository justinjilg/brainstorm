import type { GatewayFeedback } from "./types.js";

// Memoize parsed capabilities — 1 hour TTL, keyed by request ID
const _capabilitiesCache = new Map<
  string,
  { feedback: GatewayFeedback; expiresAt: number }
>();
const CAPABILITIES_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE = 100;

/** Get cached gateway feedback by request ID. */
export function getCachedFeedback(requestId: string): GatewayFeedback | null {
  const entry = _capabilitiesCache.get(requestId);
  if (!entry || Date.now() > entry.expiresAt) {
    _capabilitiesCache.delete(requestId);
    return null;
  }
  return entry.feedback;
}

/**
 * Parse BrainstormRouter response headers into structured feedback.
 * Accepts both fetch Headers objects and plain Record<string, string>.
 */
export function parseGatewayHeaders(
  headers: Headers | Record<string, string>,
): GatewayFeedback {
  const get = (key: string): string | null =>
    headers instanceof Headers ? headers.get(key) : (headers[key] ?? null);

  const feedback: GatewayFeedback = {};

  const safeFloat = (val: string | null): number | undefined => {
    if (!val) return undefined;
    const parsed = parseFloat(val);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  feedback.guardianStatus = get("x-br-guardian-status") ?? undefined;
  feedback.estimatedCost = safeFloat(get("x-br-estimated-cost"));
  feedback.actualCost = safeFloat(get("x-br-actual-cost"));
  feedback.efficiency = safeFloat(get("x-br-efficiency"));
  feedback.overheadMs = safeFloat(get("x-br-guardian-overhead-ms"));
  feedback.cacheHit = get("x-br-cache") ?? undefined;
  feedback.budgetRemaining = safeFloat(
    get("x-budget-remaining") ?? get("x-br-budget-remaining"),
  );
  feedback.selectedModel = get("x-br-routed-model") ?? undefined;
  feedback.selectionMethod = get("x-br-selection-method") ?? undefined;
  feedback.complexityScore = safeFloat(get("x-br-complexity-score"));
  feedback.requestId = get("x-request-id") ?? undefined;

  // Strip undefined values
  for (const key of Object.keys(feedback) as (keyof GatewayFeedback)[]) {
    if (feedback[key] === undefined) delete feedback[key];
  }

  // Cache by request ID for memoization
  if (feedback.requestId) {
    if (_capabilitiesCache.size >= MAX_CACHE_SIZE) {
      // Evict oldest entry
      const firstKey = _capabilitiesCache.keys().next().value;
      if (firstKey) _capabilitiesCache.delete(firstKey);
    }
    _capabilitiesCache.set(feedback.requestId, {
      feedback,
      expiresAt: Date.now() + CAPABILITIES_TTL_MS,
    });
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

  return parts.length > 0 ? parts.join(" | ") : "";
}
