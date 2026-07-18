import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordOutcome,
  isQuarantined,
  _resetQuarantineForTests,
} from "../strategies/learned.js";

describe("learned strategy — quarantine", () => {
  beforeEach(() => {
    _resetQuarantineForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetQuarantineForTests();
  });

  const fail = (model: string) =>
    recordOutcome("code-generation", model, false, 100, 0);
  const succeed = (model: string) =>
    recordOutcome("code-generation", model, true, 100, 0);

  it("quarantines a model after >80% failures across a full window", () => {
    for (let i = 0; i < 10; i++) fail("acronis:broken/model");
    expect(isQuarantined("acronis:broken/model")).toBe(true);
  });

  it("does not quarantine below the window size or failure threshold", () => {
    for (let i = 0; i < 9; i++) fail("acronis:new/model");
    expect(isQuarantined("acronis:new/model")).toBe(false);

    // 8 failures / 2 successes = exactly 80% — threshold is strict >.
    _resetQuarantineForTests();
    for (let i = 0; i < 8; i++) fail("acronis:flaky/model");
    for (let i = 0; i < 2; i++) succeed("acronis:flaky/model");
    expect(isQuarantined("acronis:flaky/model")).toBe(false);
  });

  it("counts outcomes across task types in one per-model window", () => {
    for (let i = 0; i < 5; i++)
      recordOutcome("debugging", "acronis:broken/model", false, 100, 0);
    for (let i = 0; i < 5; i++)
      recordOutcome("analysis", "acronis:broken/model", false, 100, 0);
    expect(isQuarantined("acronis:broken/model")).toBe(true);
  });

  it("releases after the cooldown and requires fresh evidence to re-trip", () => {
    for (let i = 0; i < 10; i++) fail("acronis:broken/model");
    expect(isQuarantined("acronis:broken/model")).toBe(true);

    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(isQuarantined("acronis:broken/model")).toBe(false);

    // One more failure alone must not re-quarantine (window was cleared).
    fail("acronis:broken/model");
    expect(isQuarantined("acronis:broken/model")).toBe(false);
  });
});

describe("learned strategy — quarantine map bounds", () => {
  beforeEach(() => {
    _resetQuarantineForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetQuarantineForTests();
  });

  it("keeps both tracking maps bounded when many models are quarantined in one cooldown", () => {
    // Quarantine 300 distinct models (> MAX_TRACKED_MODELS=200) within one
    // cooldown window — both maps must stay bounded, not grow unbounded.
    for (let m = 0; m < 300; m++) {
      const id = `acronis:broken/model-${m}`;
      for (let i = 0; i < 10; i++)
        recordOutcome("code-generation", id, false, 100, 0);
    }
    // Neither internal map is directly exposed; assert via behavior — the most
    // recently quarantined model is still quarantined, an early-evicted one is
    // not tracked (its window/quarantine were evicted, so it reads healthy).
    expect(isQuarantined("acronis:broken/model-299")).toBe(true);
    expect(isQuarantined("acronis:broken/model-0")).toBe(false);
  });
});

describe("learned strategy — injectable learning state", () => {
  it("swapping to a fresh state isolates quarantine/stats (no cross-instance leak)", async () => {
    const {
      createRoutingLearningState,
      __setRoutingLearningState,
      getRoutingLearningState,
    } = await import("../strategies/learned.js");

    // Instance 1: quarantine a model.
    __setRoutingLearningState(createRoutingLearningState());
    for (let i = 0; i < 10; i++)
      recordOutcome("code-generation", "acronis:broken/model", false, 100, 0);
    expect(isQuarantined("acronis:broken/model")).toBe(true);
    const first = getRoutingLearningState();

    // Instance 2: a fresh state — the model is NOT quarantined here.
    __setRoutingLearningState(createRoutingLearningState());
    expect(isQuarantined("acronis:broken/model")).toBe(false);

    // Instance 1 still holds its quarantine (state was swapped, not mutated).
    expect(first.quarantinedUntil.has("acronis:broken/model")).toBe(true);

    // Restore the default process state so other tests are unaffected.
    __setRoutingLearningState(createRoutingLearningState());
  });
});
