import { describe, expect, it } from "vitest";
import {
  buildE2EScorecard,
  formatE2EScorecard,
  wilsonInterval,
} from "../e2e/scorecard.js";
import type { E2ETrialResult } from "../e2e/types.js";

function result(overrides: Partial<E2ETrialResult> = {}): E2ETrialResult {
  return {
    taskId: "coding-example",
    modelId: "local:test",
    trial: 1,
    status: "succeeded",
    correctness: 1,
    efficiency: 0.4,
    resilience: 1,
    governance: 1,
    durationMs: 1_000,
    costUsd: 0,
    attempts: 1,
    recovered: false,
    silentFailure: false,
    stateCorruption: false,
    artifactPaths: ["src/index.ts"],
    ...overrides,
  };
}

describe("buildE2EScorecard", () => {
  it("keeps correctness independent from efficiency and optional quality", () => {
    const scorecard = buildE2EScorecard("kernel-e2e-v1", 1, [result()]);

    expect(scorecard.axes.correctness.mean).toBe(1);
    expect(scorecard.axes.efficiency.mean).toBe(0.4);
    expect(scorecard.axes.quality).toMatchObject({ mean: 0, samples: 0 });
    expect(scorecard.verifiedCompletionRate).toBe(1);
  });

  it("measures recovery only on trials that entered recovery", () => {
    const scorecard = buildE2EScorecard("kernel-e2e-v1", 1, [
      result(),
      result({ taskId: "web-recovery", attempts: 2, recovered: true }),
      result({
        taskId: "coding-failed-recovery",
        status: "failed",
        attempts: 2,
        recovered: false,
        resilience: 0,
      }),
    ]);

    expect(scorecard.recoverySuccessRate).toBe(0.5);
  });

  it("surfaces silent failures and state corruption separately", () => {
    const scorecard = buildE2EScorecard("kernel-e2e-v1", 1, [
      result({ silentFailure: true }),
      result({ taskId: "second", stateCorruption: true }),
    ]);

    expect(scorecard.silentFailureRate).toBe(0.5);
    expect(scorecard.stateCorruptionRate).toBe(0.5);
  });

  it("formats a reviewable five-axis report", () => {
    const text = formatE2EScorecard(
      buildE2EScorecard("kernel-e2e-v1", 3, [result({ quality: 0.95 })], 42),
    );

    expect(text).toContain("Brainstorm E2E Scorecard: kernel-e2e-v1");
    expect(text).toContain("correctness");
    expect(text).toContain("quality");
    expect(text).toContain("Silent failures");
  });
});

describe("wilsonInterval", () => {
  it("returns a bounded interval and narrows with more evidence", () => {
    const small = wilsonInterval(9, 10);
    const large = wilsonInterval(90, 100);

    expect(small.lower).toBeGreaterThanOrEqual(0);
    expect(small.upper).toBeLessThanOrEqual(1);
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
  });
});
