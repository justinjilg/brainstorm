import { describe, it, expect } from "vitest";
import { buildRunOutcome } from "../agent/loop-outcome.js";
import type { ModelAttemptOutcome } from "@brainst0rm/shared";

const attempt = (
  over: Partial<ModelAttemptOutcome> = {},
): ModelAttemptOutcome => ({
  modelId: "m1",
  taskType: "general" as any,
  status: "succeeded",
  stopCause: "natural_stop",
  latencyMs: 10,
  costUsd: 0,
  ...over,
});

const base = {
  upstreamAttempts: [] as ModelAttemptOutcome[],
  thisAttempt: attempt(),
  synthAttempt: null,
  upstreamRecovery: [],
  didSynthesize: false,
  turnSuccess: true,
  finalModelId: "m1",
  initialStopCause: "natural_stop" as const,
  hasFinalResponse: true,
  madeChanges: false,
  costUsd: 0,
};

describe("buildRunOutcome — pure aggregate outcome (TurnController seam)", () => {
  it("a clean single-attempt success has one attempt and no recovery", () => {
    const o = buildRunOutcome(base);
    expect(o.status).toBe("succeeded");
    expect(o.attempts).toHaveLength(1);
    expect(o.finalModelId).toBe("m1");
    expect(o.recovery).toBeUndefined();
    expect(o.verification).toBe("not_run");
  });

  it("orders attempts: upstream → this → synthesis (Codex #8)", () => {
    const up = attempt({ modelId: "up", status: "failed" });
    const synth = attempt({ modelId: "synth" });
    const o = buildRunOutcome({
      ...base,
      upstreamAttempts: [up],
      thisAttempt: attempt({ modelId: "main" }),
      synthAttempt: synth,
      didSynthesize: true,
    });
    expect(o.attempts.map((a) => a.modelId)).toEqual(["up", "main", "synth"]);
  });

  it("omits the synthesis attempt when none ran", () => {
    const o = buildRunOutcome({
      ...base,
      thisAttempt: attempt({ modelId: "main" }),
      synthAttempt: null,
    });
    expect(o.attempts.map((a) => a.modelId)).toEqual(["main"]);
  });

  it("composes the ordered recovery sequence, appending forced_synthesis (Codex #9)", () => {
    const o = buildRunOutcome({
      ...base,
      upstreamRecovery: ["fallback"],
      didSynthesize: true,
      synthAttempt: attempt({ modelId: "synth" }),
    });
    // The fallback is preserved, not erased by the synthesis tag.
    expect(o.recovery).toEqual(["fallback", "forced_synthesis"]);
  });

  it("does not append forced_synthesis when this turn didn't synthesize", () => {
    const o = buildRunOutcome({
      ...base,
      upstreamRecovery: ["tool_nudge"],
      didSynthesize: false,
    });
    expect(o.recovery).toEqual(["tool_nudge"]);
  });

  it("recovery is undefined (not empty array) for a clean run", () => {
    const o = buildRunOutcome({ ...base, upstreamRecovery: [], didSynthesize: false });
    expect(o.recovery).toBeUndefined();
  });

  it("initialStopCause is the FIRST attempt's cause, not this turn's (recovery preserved)", () => {
    // Upstream attempt hit the step cap; this (fallback) turn stopped naturally.
    const o = buildRunOutcome({
      ...base,
      upstreamAttempts: [attempt({ stopCause: "step_cap_reached" })],
      thisAttempt: attempt({ stopCause: "natural_stop" }),
      initialStopCause: "natural_stop",
      upstreamRecovery: ["fallback"],
    });
    // The recovered run does NOT masquerade as a clean first stop.
    expect(o.initialStopCause).toBe("step_cap_reached");
  });

  it("falls back to this turn's stop cause when there are no upstream attempts", () => {
    const o = buildRunOutcome({
      ...base,
      upstreamAttempts: [],
      thisAttempt: attempt({ stopCause: "step_cap_reached" }),
      initialStopCause: "step_cap_reached",
    });
    expect(o.initialStopCause).toBe("step_cap_reached");
  });

  it("a failed run has no finalModelId and status failed", () => {
    const o = buildRunOutcome({
      ...base,
      turnSuccess: false,
      hasFinalResponse: false,
    });
    expect(o.status).toBe("failed");
    expect(o.finalModelId).toBeUndefined();
  });

  it("passes through hasFinalResponse, madeChanges, and cost verbatim", () => {
    const o = buildRunOutcome({
      ...base,
      hasFinalResponse: true,
      madeChanges: true,
      costUsd: 0.0042,
    });
    expect(o.hasFinalResponse).toBe(true);
    expect(o.madeChanges).toBe(true);
    expect(o.costUsd).toBe(0.0042);
  });
});
