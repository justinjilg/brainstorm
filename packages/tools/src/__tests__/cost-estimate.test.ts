import { describe, it, expect } from "vitest";
import { costEstimateTool } from "../builtin/cost-estimate.js";

describe("cost-estimate tool", () => {
  it("should return estimates for multiple tiers", async () => {
    const result = await costEstimateTool.execute({
      estimatedInputTokens: 1000000,
      estimatedOutputTokens: 1000000,
      taskDescription: "Large refactor",
    });

    expect(result).toHaveProperty("task", "Large refactor");
    expect(result).toHaveProperty("estimates");

    const estimates = (result as any).estimates;
    expect(Array.isArray(estimates)).toBe(true);
    expect(estimates.length).toBe(3);

    const qualityTier = estimates.find((e: any) => e.tier === "quality");
    expect(qualityTier).toBeDefined();
    // 1M input @ $3.0 + 1M output @ $15.0 = $18.0
    expect(qualityTier.costRaw).toBe(18.0);
    expect(qualityTier.estimatedCost).toBe("$18.0000");

    const cheapTier = estimates.find((e: any) => e.tier === "cheap");
    expect(cheapTier).toBeDefined();
    // 1M input @ $0.10 + 1M output @ $0.40 = $0.50
    expect(cheapTier.costRaw).toBe(0.5);
    expect(cheapTier.estimatedCost).toBe("$0.5000");
  });

  it("should calculate fractional costs correctly", async () => {
    const result = await costEstimateTool.execute({
      estimatedInputTokens: 500000,
      estimatedOutputTokens: 10000,
      taskDescription: "Small PR review",
    });

    const estimates = (result as any).estimates;
    const qualityTier = estimates.find((e: any) => e.tier === "quality");

    // 0.5M input @ $3.0 = $1.5
    // 0.01M output @ $15.0 = $0.15
    // Total = $1.65
    expect(qualityTier.costRaw).toBeCloseTo(1.65);
    expect(qualityTier.estimatedCost).toBe("$1.6500");
  });
});
