/**
 * Routing-stream observer — feeds BR's push-first routing-decision events
 * into the learned-strategy's Thompson posteriors (in-memory `modelStats`).
 *
 * BR already knows which model it picked for each completion and what that
 * decision cost. Pre-Phase-2, the CLI only learned from completions that
 * went through its own `recordOutcome()` call site in core/src/agent/loop.ts.
 * That meant the strategy was blind to anything BR routed on our behalf
 * from other sessions, other tools, or any caller that didn't go through
 * the local agent loop.
 *
 * 2026-08-27: BR's stream now carries `kind: "outcome"` events at completion
 * time with a truthful, validity-derived `success` label and real
 * `latency_ms` — the exact schema extension this module's original header
 * flagged for. Only outcome events feed the posterior now. Route-time
 * decision events are observed but NOT recorded: recording them as
 * `success=true` (the pre-outcome behavior) made the posterior an EWMA of a
 * constant — models could only ever look better. Against an older BR that
 * emits no outcomes, the stream contributes nothing rather than poison.
 *
 * `cache=hit` events are deliberately skipped — they represent cache-layer
 * behavior, not new information about the model's underlying capability.
 */

import { recordOutcome } from "./strategies/learned.js";
import { createLogger } from "@brainst0rm/shared";
import type {
  RoutingEventStream,
  RoutingStreamEvent,
} from "@brainst0rm/gateway";

const log = createLogger("stream-observer");

export interface StreamObserverOptions {
  /**
   * Include cache-hit events as success samples. Off by default because a
   * cache hit is uninformative about the model's underlying behavior — we
   * already observed the real response when the cache was populated.
   */
  includeCacheHits?: boolean;
  /**
   * Optional filter: only process events matching this predicate. Useful
   * for tests, or to scope observation to specific task types.
   */
  filter?: (event: RoutingStreamEvent) => boolean;
}

export interface StreamObserverStats {
  /** Events seen (all types, before filtering). */
  eventsObserved: number;
  /** Events that resulted in a recordOutcome call. */
  outcomesRecorded: number;
  /** Events skipped because cache=hit (and includeCacheHits was false). */
  cacheHitsSkipped: number;
  /** Events skipped by the optional filter. */
  filteredOut: number;
  /** Route-time decision events observed but not recorded (no outcome label). */
  decisionsSkipped: number;
}

/**
 * Subscribe a Thompson-posterior updater to the routing-decision stream.
 * Returns an unsubscribe function that detaches the observer without
 * tearing down the stream itself (the stream's owner manages its lifecycle).
 */
export function attachStreamToLearnedStrategy(
  stream: RoutingEventStream,
  options: StreamObserverOptions = {},
): {
  unsubscribe: () => void;
  stats: () => StreamObserverStats;
} {
  const stats: StreamObserverStats = {
    eventsObserved: 0,
    outcomesRecorded: 0,
    cacheHitsSkipped: 0,
    filteredOut: 0,
    decisionsSkipped: 0,
  };

  const unsubscribe = stream.onEvent((event) => {
    stats.eventsObserved++;

    if (options.filter && !options.filter(event)) {
      stats.filteredOut++;
      return;
    }

    if (event.decision.cache === "hit" && !options.includeCacheHits) {
      stats.cacheHitsSkipped++;
      return;
    }

    // Only completion outcomes carry a truthful label. Route-time decisions
    // have no outcome yet — recording them as success (the old behavior)
    // trained the posterior on a constant.
    if (
      event.decision.kind !== "outcome" ||
      event.decision.success === undefined
    ) {
      stats.decisionsSkipped++;
      return;
    }

    recordOutcome(
      event.decision.task_type,
      event.decision.selected_model,
      event.decision.success,
      event.decision.latency_ms ?? 0,
      event.decision.cost_estimate_usd,
    );
    stats.outcomesRecorded++;

    log.debug(
      {
        eventId: event.eventId,
        taskType: event.decision.task_type,
        model: event.decision.selected_model,
        strategy: event.decision.strategy,
        success: event.decision.success,
        latencyMs: event.decision.latency_ms,
        cost: event.decision.cost_estimate_usd,
      },
      "recorded stream outcome",
    );
  });

  return {
    unsubscribe,
    stats: () => ({ ...stats }),
  };
}
