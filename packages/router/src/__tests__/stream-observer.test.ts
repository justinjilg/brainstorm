/**
 * Observer tests — verify the stream-to-Thompson bridge without touching
 * the network. We stub a minimal `RoutingEventStream`-shaped object that
 * exposes an `onEvent(cb)` method and a trigger helper so tests can push
 * synthetic events in and assert on `recordOutcome`'s side-effects.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachStreamToLearnedStrategy,
  type StreamObserverOptions,
} from "../stream-observer.js";
import {
  loadStats,
  getSamplesForTaskType,
  getTotalSamples,
} from "../strategies/learned.js";
import type {
  RoutingEventStream,
  RoutingStreamEvent,
} from "@brainst0rm/gateway";

function makeStub(): {
  stream: RoutingEventStream;
  emit: (event: RoutingStreamEvent) => void;
} {
  const subs = new Set<(e: RoutingStreamEvent) => void>();
  const stream = {
    onEvent(cb: (e: RoutingStreamEvent) => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  } as unknown as RoutingEventStream;
  return {
    stream,
    emit: (e) => subs.forEach((cb) => cb(e)),
  };
}

function mkEvent(
  i: number,
  overrides: Partial<RoutingStreamEvent["decision"]> = {},
): RoutingStreamEvent {
  return {
    eventId: i,
    decision: {
      ts: "2026-04-22T23:00:00Z",
      request_id: `req-${i}`,
      task_type: "code",
      selected_model: "deepseek/deepseek-chat",
      strategy: "quality",
      why: "test",
      cost_estimate_usd: 0.001,
      cache: "miss",
      tenant_id: "t1",
      ...overrides,
    },
  };
}

beforeEach(() => {
  // Reset the strategy's in-memory state between tests.
  loadStats([]);
});

afterEach(() => {
  loadStats([]);
});

describe("attachStreamToLearnedStrategy", () => {
  it("records cache-miss events as successful outcomes", () => {
    const { stream, emit } = makeStub();
    const { stats } = attachStreamToLearnedStrategy(stream);

    emit(mkEvent(1, { task_type: "code", cache: "miss" }));
    emit(mkEvent(2, { task_type: "code", cache: "miss" }));
    emit(mkEvent(3, { task_type: "code", cache: "miss" }));

    expect(stats().eventsObserved).toBe(3);
    expect(stats().outcomesRecorded).toBe(3);
    expect(getSamplesForTaskType("code")).toBe(3);
  });

  it("skips cache-hit events by default", () => {
    const { stream, emit } = makeStub();
    const { stats } = attachStreamToLearnedStrategy(stream);

    emit(mkEvent(1, { cache: "miss" }));
    emit(mkEvent(2, { cache: "hit" }));
    emit(mkEvent(3, { cache: "hit" }));
    emit(mkEvent(4, { cache: "miss" }));

    expect(stats().eventsObserved).toBe(4);
    expect(stats().cacheHitsSkipped).toBe(2);
    expect(stats().outcomesRecorded).toBe(2);
    expect(getTotalSamples()).toBe(2);
  });

  it("records cache-hit events when includeCacheHits is true", () => {
    const { stream, emit } = makeStub();
    const { stats } = attachStreamToLearnedStrategy(stream, {
      includeCacheHits: true,
    });

    emit(mkEvent(1, { cache: "miss" }));
    emit(mkEvent(2, { cache: "hit" }));
    emit(mkEvent(3, { cache: "hit" }));

    expect(stats().cacheHitsSkipped).toBe(0);
    expect(stats().outcomesRecorded).toBe(3);
    expect(getTotalSamples()).toBe(3);
  });

  it("applies the filter before the cache-hit check", () => {
    const { stream, emit } = makeStub();
    const filter: StreamObserverOptions["filter"] = (e) =>
      e.decision.task_type === "code";
    const { stats } = attachStreamToLearnedStrategy(stream, { filter });

    emit(mkEvent(1, { task_type: "code", cache: "miss" }));
    emit(mkEvent(2, { task_type: "sql", cache: "miss" }));
    emit(mkEvent(3, { task_type: "sql", cache: "hit" }));
    emit(mkEvent(4, { task_type: "code", cache: "miss" }));

    expect(stats().filteredOut).toBe(2);
    expect(stats().outcomesRecorded).toBe(2);
    expect(getSamplesForTaskType("code")).toBe(2);
    expect(getSamplesForTaskType("sql")).toBe(0);
  });

  it("preserves per-task / per-model sample accounting", () => {
    const { stream, emit } = makeStub();
    attachStreamToLearnedStrategy(stream);

    emit(mkEvent(1, { task_type: "code", selected_model: "m1" }));
    emit(mkEvent(2, { task_type: "code", selected_model: "m2" }));
    emit(mkEvent(3, { task_type: "code", selected_model: "m1" }));
    emit(mkEvent(4, { task_type: "sql", selected_model: "m1" }));

    // getSamplesForTaskType aggregates across models
    expect(getSamplesForTaskType("code")).toBe(3);
    expect(getSamplesForTaskType("sql")).toBe(1);
  });

  it("unsubscribe stops further recording", () => {
    const { stream, emit } = makeStub();
    const { stats, unsubscribe } = attachStreamToLearnedStrategy(stream);

    emit(mkEvent(1));
    expect(stats().outcomesRecorded).toBe(1);

    unsubscribe();
    emit(mkEvent(2));
    emit(mkEvent(3));

    expect(stats().outcomesRecorded).toBe(1); // unchanged post-unsubscribe
  });
});
