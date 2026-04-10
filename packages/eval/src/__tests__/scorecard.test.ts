import { describe, expect, it } from "vitest";
import { formatScorecard, formatComparison } from "../scorecard.js";
import type { CapabilityScorecard, CapabilityDimension } from "../types.js";

describe("formatScorecard", () => {
  const createScorecard = (
    dimensions: Partial<CapabilityScorecard["dimensions"]> = {},
    overrides: Partial<CapabilityScorecard> = {},
  ): CapabilityScorecard => ({
    modelId: "test-model",
    evaluatedAt: Date.now(),
    dimensions: {
      "tool-selection": { score: 1, passed: 5, total: 5 },
      "tool-sequencing": { score: 0.8, passed: 4, total: 5 },
      "code-correctness": { score: 0.6, passed: 3, total: 5 },
      "multi-step": { score: 0, passed: 0, total: 0 },
      "instruction-adherence": { score: 1, passed: 2, total: 2 },
      "context-utilization": { score: 0.5, passed: 1, total: 2 },
      "self-correction": { score: 0, passed: 0, total: 0 },
      ...dimensions,
    },
    overall: {
      score: 0.75,
      passed: 15,
      total: 20,
      cost: 0.0523,
    },
    ...overrides,
  });

  it("includes model name in header", () => {
    const scorecard = createScorecard({}, { modelId: "claude-3-opus" });
    const formatted = formatScorecard(scorecard);

    expect(formatted).toContain("Capability Scorecard: claude-3-opus");
  });

  it("formats each dimension with score bar", () => {
    const scorecard = createScorecard({
      "tool-selection": { score: 1, passed: 5, total: 5 },
    });
    const formatted = formatScorecard(scorecard);

    expect(formatted).toContain("Tool Selection");
    expect(formatted).toContain("5/5 (100%)");
    expect(formatted).toContain("██████████");
  });

  it("renders partial bars for fractional scores", () => {
    const scorecard = createScorecard({
      "tool-selection": { score: 0.5, passed: 2, total: 4 },
    });
    const formatted = formatScorecard(scorecard);

    expect(formatted).toContain("2/4 (50%)");
    expect(formatted).toContain("█████░░░░░");
  });

  it("skips dimensions with zero total probes", () => {
    const scorecard = createScorecard({
      "multi-step": { score: 0, passed: 0, total: 0 },
      "self-correction": { score: 0, passed: 0, total: 0 },
    });
    const formatted = formatScorecard(scorecard);

    expect(formatted).not.toContain("Multi-Step");
    expect(formatted).not.toContain("Self-Correction");
  });

  it("formats overall statistics", () => {
    const scorecard = createScorecard(
      {},
      { overall: { score: 0.85, passed: 17, total: 20, cost: 0.1234 } },
    );
    const formatted = formatScorecard(scorecard);

    expect(formatted).toContain("Overall");
    expect(formatted).toContain("17/20 (85%)");
    expect(formatted).toContain("$0.1234");
  });

  it("formats cost with 4 decimal places", () => {
    const scorecard = createScorecard(
      {},
      { overall: { score: 1, passed: 1, total: 1, cost: 0.5 } },
    );
    const formatted = formatScorecard(scorecard);

    expect(formatted).toContain("$0.5000");
  });
});

describe("formatComparison", () => {
  const createDimension = (
    score: number,
    passed: number,
    total: number,
  ): CapabilityScorecard["dimensions"][CapabilityDimension] => ({
    score,
    passed,
    total,
  });

  const createScorecard = (
    modelId: string,
    dimensionScores: Record<
      CapabilityDimension,
      { score: number; passed: number; total: number }
    >,
  ): CapabilityScorecard => ({
    modelId,
    evaluatedAt: Date.now(),
    dimensions: {
      "tool-selection": createDimension(0, 0, 0),
      "tool-sequencing": createDimension(0, 0, 0),
      "code-correctness": createDimension(0, 0, 0),
      "multi-step": createDimension(0, 0, 0),
      "instruction-adherence": createDimension(0, 0, 0),
      "context-utilization": createDimension(0, 0, 0),
      "self-correction": createDimension(0, 0, 0),
      ...dimensionScores,
    },
    overall: {
      score:
        Object.values(dimensionScores).reduce((sum, d) => sum + d.score, 0) /
        Object.keys(dimensionScores).length,
      passed: Object.values(dimensionScores).reduce(
        (sum, d) => sum + d.passed,
        0,
      ),
      total: Object.values(dimensionScores).reduce(
        (sum, d) => sum + d.total,
        0,
      ),
      cost: 0.1,
    },
  });

  it("returns message for empty scorecards array", () => {
    const formatted = formatComparison([]);

    expect(formatted).toContain("No eval results found");
  });

  it("formats single scorecard comparison", () => {
    const scorecard = createScorecard("model-a", {
      "tool-selection": { score: 0.8, passed: 4, total: 5 },
    });
    const formatted = formatComparison([scorecard]);

    expect(formatted).toContain("model-a");
    expect(formatted).toContain("80%");
  });

  it("formats multiple scorecards side by side", () => {
    const scorecards = [
      createScorecard("claude-3-opus", {
        "tool-selection": { score: 1, passed: 5, total: 5 },
      }),
      createScorecard("gpt-4", {
        "tool-selection": { score: 0.8, passed: 4, total: 5 },
      }),
    ];
    const formatted = formatComparison(scorecards);

    expect(formatted).toContain("opus");
    expect(formatted).toContain("gpt-4");
    expect(formatted).toContain("100%");
    expect(formatted).toContain("80%");
  });

  it("shows dash for dimensions with no data", () => {
    const scorecards = [
      createScorecard("model-a", {
        "tool-selection": { score: 0.8, passed: 4, total: 5 },
        "multi-step": { score: 0, passed: 0, total: 0 },
      }),
    ];
    const formatted = formatComparison(scorecards);

    expect(formatted).toContain("—");
  });

  it("formats costs for all models", () => {
    const scorecards = [
      {
        ...createScorecard("model-a", {
          "tool-selection": { score: 1, passed: 1, total: 1 },
        }),
        overall: { score: 1, passed: 1, total: 1, cost: 0.123 },
      },
      {
        ...createScorecard("model-b", {
          "tool-selection": { score: 1, passed: 1, total: 1 },
        }),
        overall: { score: 1, passed: 1, total: 1, cost: 0.456 },
      },
    ];
    const formatted = formatComparison(scorecards);

    expect(formatted).toContain("$0.123");
    expect(formatted).toContain("$0.456");
  });

  it("pads columns based on longest model name", () => {
    const scorecards = [
      createScorecard("very-long-model-name-that-needs-padding", {
        "tool-selection": { score: 1, passed: 1, total: 1 },
      }),
      createScorecard("short", {
        "tool-selection": { score: 0.5, passed: 1, total: 2 },
      }),
    ];
    const formatted = formatComparison(scorecards);

    expect(formatted).toContain("very-long-model-name-that-needs-padding");
    expect(formatted).toContain("short");
  });
});
