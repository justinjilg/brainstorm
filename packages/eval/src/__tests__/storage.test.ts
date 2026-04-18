import { describe, expect, it } from "vitest";
import { buildScorecard, saveEvalRun } from "../storage.js";
import type { EvalRun, ProbeResult, CapabilityDimension } from "../types.js";

describe("buildScorecard", () => {
  const createProbeResult = (
    capability: CapabilityDimension,
    passed: boolean,
    overrides: Partial<ProbeResult> = {},
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
    ...overrides,
  });

  const computeScores = (results: ProbeResult[]): EvalRun["scores"] => {
    const dimensions: CapabilityDimension[] = [
      "tool-selection",
      "tool-sequencing",
      "code-correctness",
      "multi-step",
      "instruction-adherence",
      "context-utilization",
      "self-correction",
    ];

    const scores = {} as EvalRun["scores"];
    for (const dim of dimensions) {
      const dimResults = results.filter((r) => r.capability === dim);
      if (dimResults.length === 0) {
        scores[dim] = 0;
      } else {
        scores[dim] =
          dimResults.filter((r) => r.passed).length / dimResults.length;
      }
    }
    return scores;
  };

  const createEvalRun = (
    results: ProbeResult[],
    overrides: Partial<EvalRun> = {},
  ): EvalRun => ({
    id: "test-run",
    modelId: "claude-3-5-sonnet",
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    results,
    scores: computeScores(results),
    totalCost: results.reduce((sum, r) => sum + r.cost, 0),
    ...overrides,
  });

  it("builds a scorecard with all dimensions represented", () => {
    const results: ProbeResult[] = [
      createProbeResult("tool-selection", true),
      createProbeResult("tool-sequencing", true),
      createProbeResult("code-correctness", false),
    ];
    const run = createEvalRun(results);
    const scorecard = buildScorecard(run);

    expect(scorecard.modelId).toBe("claude-3-5-sonnet");
    expect(scorecard.dimensions["tool-selection"]).toEqual({
      score: 1,
      passed: 1,
      total: 1,
    });
    expect(scorecard.dimensions["tool-sequencing"]).toEqual({
      score: 1,
      passed: 1,
      total: 1,
    });
    expect(scorecard.dimensions["code-correctness"]).toEqual({
      score: 0,
      passed: 0,
      total: 1,
    });
  });

  it("calculates aggregate scores for multiple probes per dimension", () => {
    const results: ProbeResult[] = [
      createProbeResult("tool-selection", true),
      createProbeResult("tool-selection", true),
      createProbeResult("tool-selection", false),
      createProbeResult("tool-selection", true),
    ];
    const run = createEvalRun(results);
    const scorecard = buildScorecard(run);

    expect(scorecard.dimensions["tool-selection"]).toEqual({
      score: 0.75,
      passed: 3,
      total: 4,
    });
  });

  it("computes overall score as percentage of passed probes", () => {
    const results: ProbeResult[] = [
      createProbeResult("tool-selection", true),
      createProbeResult("tool-sequencing", true),
      createProbeResult("code-correctness", false),
      createProbeResult("multi-step", false),
    ];
    const run = createEvalRun(results);
    const scorecard = buildScorecard(run);

    expect(scorecard.overall.score).toBe(0.5);
    expect(scorecard.overall.passed).toBe(2);
    expect(scorecard.overall.total).toBe(4);
  });

  it("handles empty results with zero scores", () => {
    const run = createEvalRun([]);
    const scorecard = buildScorecard(run);

    expect(scorecard.overall.score).toBe(0);
    expect(scorecard.overall.passed).toBe(0);
    expect(scorecard.overall.total).toBe(0);
    expect(scorecard.overall.cost).toBe(0);
  });

  it("saveEvalRun produces a finite startedAt when results are empty", () => {
    // Before the fix, Math.min(...[]) === Infinity and the JSON serialization
    // landed `null` in startedAt — downstream arithmetic then went NaN.
    const run = saveEvalRun("some-model", []);
    expect(Number.isFinite(run.startedAt)).toBe(true);
    expect(run.startedAt).toBeGreaterThan(0);
    // startedAt == completedAt is fine for a zero-result run.
    expect(run.startedAt).toBeLessThanOrEqual(run.completedAt ?? Infinity);
  });

  it("sums total cost from all probe results", () => {
    const results: ProbeResult[] = [
      createProbeResult("tool-selection", true, { cost: 0.005 }),
      createProbeResult("tool-sequencing", true, { cost: 0.003 }),
      createProbeResult("code-correctness", false, { cost: 0.002 }),
    ];
    const run = createEvalRun(results);
    const scorecard = buildScorecard(run);

    expect(scorecard.overall.cost).toBeCloseTo(0.01, 5);
  });

  it("uses completedAt timestamp for evaluatedAt", () => {
    const completedAt = 1234567890;
    const run = createEvalRun([], { completedAt });
    const scorecard = buildScorecard(run);

    expect(scorecard.evaluatedAt).toBe(completedAt);
  });

  it("falls back to current time when completedAt is missing", () => {
    const before = Date.now();
    const run = createEvalRun([], { completedAt: undefined });
    const scorecard = buildScorecard(run);
    const after = Date.now();

    expect(scorecard.evaluatedAt).toBeGreaterThanOrEqual(before);
    expect(scorecard.evaluatedAt).toBeLessThanOrEqual(after);
  });
});
