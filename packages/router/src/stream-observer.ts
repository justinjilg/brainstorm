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
 * Phase 2 wires the SSE stream in: every `cache=miss` event that arrives
 * records an outcome with `success=true` (failure events don't exist in
 * the current event taxonomy; if/when `auth.failure` or `dispatch.failed`
 * types ship, this module should extend to record `success=false`).
 *
 * `cache=hit` events are deliberately skipped — they represent cache-layer
 * behavior, not new information about the model's underlying capability.
 *
 * Latency is not surfaced on the current event schema, so we record 0.
 * That's technically a bias toward "all models are equally fast" in the
 * aggregate — flag for a future BR-side schema extension to include
 * `latency_ms` on the event.
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

    // Translate a routing-decision event into a Thompson outcome.
    // success=true because the current event taxonomy only emits on
    // successful routing. Latency is unknown on-wire; record 0.
    recordOutcome(
      event.decision.task_type,
      event.decision.selected_model,
      true,
      0,
      event.decision.cost_estimate_usd,
    );
    stats.outcomesRecorded++;

    log.debug(
      {
        eventId: event.eventId,
        taskType: event.decision.task_type,
        model: event.decision.selected_model,
        strategy: event.decision.strategy,
        cache: event.decision.cache,
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
