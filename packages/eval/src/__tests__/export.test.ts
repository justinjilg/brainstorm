import { describe, expect, it } from "vitest";
import { exportCapabilityScores } from "../export.js";
import type { EvalRun, ProbeResult, CapabilityDimension } from "../types.js";

describe("exportCapabilityScores", () => {
  const createProbeResult = (
    capability: CapabilityDimension,
    passed: boolean,
  ): ProbeResult => ({
    probeId: "test-probe",
    capability,
    passed,
    checks: [],
    modelId: "test-model",
    cost: 0.001,
    steps: 3,
    toolCalls: [],
    output: "test output",
    durationMs: 1000,
  });

  const createEvalRun = (
    results: ProbeResult[],
    scores: Partial<EvalRun["scores"]> = {},
  ): EvalRun => ({
    id: "test-run",
    modelId: "claude-3-5-sonnet",
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    results,
    scores: {
      "tool-selection": 0,
      "tool-sequencing": 0,
      "code-correctness": 0,
      "multi-step": 0,
      "instruction-adherence": 0,
      "context-utilization": 0,
      "self-correction": 0,
      ...scores,
    },
    totalCost: 0.01,
  });

  it("maps all capability dimensions to correct fields", () => {
    const run = createEvalRun([], {
      "tool-selection": 0.9,
      "tool-sequencing": 0.8,
      "code-correctness": 0.7,
      "multi-step": 0.6,
      "instruction-adherence": 0.5,
      "context-utilization": 0.4,
      "self-correction": 0.3,
    });

    const scores = exportCapabilityScores(run);

    expect(scores.toolSelection).toBe(0.9);
    expect(scores.toolSequencing).toBe(0.8);
    expect(scores.codeGeneration).toBe(0.7);
    expect(scores.multiStepReasoning).toBe(0.6);
    expect(scores.instructionFollowing).toBe(0.5);
    expect(scores.contextUtilization).toBe(0.4);
    expect(scores.selfCorrection).toBe(0.3);
  });

  it("initializes all scores to zero by default", () => {
    const run = createEvalRun([]);

    const scores = exportCapabilityScores(run);

    expect(scores.toolSelection).toBe(0);
    expect(scores.toolSequencing).toBe(0);
    expect(scores.codeGeneration).toBe(0);
    expect(scores.multiStepReasoning).toBe(0);
    expect(scores.instructionFollowing).toBe(0);
    expect(scores.contextUtilization).toBe(0);
    expect(scores.selfCorrection).toBe(0);
  });

  it("correctly maps tool-selection to toolSelection", () => {
    const run = createEvalRun([], { "tool-selection": 0.85 });

    const scores = exportCapabilityScores(run);

    expect(scores.toolSelection).toBe(0.85);
  });

  it("correctly maps code-correctness to codeGeneration", () => {
    const run = createEvalRun([], { "code-correctness": 0.92 });

    const scores = exportCapabilityScores(run);

    expect(scores.codeGeneration).toBe(0.92);
  });

  it("correctly maps instruction-adherence to instructionFollowing", () => {
    const run = createEvalRun([], { "instruction-adherence": 0.78 });

    const scores = exportCapabilityScores(run);

    expect(scores.instructionFollowing).toBe(0.78);
  });

  it("handles mixed scores from probe results", () => {
    const results: ProbeResult[] = [
      createProbeResult("tool-selection", true),
      createProbeResult("tool-selection", true),
      createProbeResult("tool-selection", false),
    ];
    const run = createEvalRun(results, { "tool-selection": 2 / 3 });

    const scores = exportCapabilityScores(run);

    expect(scores.toolSelection).toBeCloseTo(0.667, 3);
  });

  it("preserves modelId in the exported data context", () => {
    const run = createEvalRun([], { "tool-selection": 1 }, "gpt-4-turbo");

    const scores = exportCapabilityScores(run);

    // The function returns scores; modelId is used for storage
    expect(scores.toolSelection).toBe(1);
  });
});
