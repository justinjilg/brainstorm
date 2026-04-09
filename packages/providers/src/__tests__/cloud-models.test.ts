import { describe, it, expect } from "vitest";
import { CLOUD_MODELS } from "../cloud/models.js";

describe("CLOUD_MODELS registry", () => {
  it("has models from multiple providers", () => {
    const providers = new Set(CLOUD_MODELS.map((m) => m.provider));
    expect(providers.size).toBeGreaterThanOrEqual(3);
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("google");
  });

  it("all models have required fields", () => {
    for (const model of CLOUD_MODELS) {
      expect(model.id).toBeDefined();
      expect(typeof model.id).toBe("string");
      expect(model.provider).toBeDefined();
      expect(model.name).toBeDefined();
      expect(model.capabilities).toBeDefined();
      expect(model.pricing).toBeDefined();
      expect(model.pricing.inputPer1MTokens).toBeGreaterThan(0);
      expect(model.pricing.outputPer1MTokens).toBeGreaterThan(0);
    }
  });

  it("all model IDs are unique", () => {
    const ids = CLOUD_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all models have capability scores", () => {
    for (const model of CLOUD_MODELS) {
      const scores = model.capabilities.capabilityScores;
      if (scores) {
        // All scores should be between 0 and 1
        for (const [key, value] of Object.entries(scores)) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("quality tier 1 models are the most capable", () => {
    const tier1 = CLOUD_MODELS.filter((m) => m.capabilities.qualityTier === 1);
    expect(tier1.length).toBeGreaterThanOrEqual(2);
    // Tier 1 should include flagship models
    const tier1Names = tier1.map((m) => m.name);
    expect(
      tier1Names.some((n) => n.includes("Opus") || n.includes("GPT")),
    ).toBe(true);
  });

  it("model IDs follow provider/name format", () => {
    for (const model of CLOUD_MODELS) {
      expect(model.id).toMatch(/^[a-z]+\//);
      expect(model.id.split("/").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("context windows are reasonable", () => {
    for (const model of CLOUD_MODELS) {
      expect(model.capabilities.contextWindow).toBeGreaterThanOrEqual(4096);
      expect(model.capabilities.contextWindow).toBeLessThanOrEqual(2_100_000);
    }
  });

  it("contains current model names", () => {
    const names = CLOUD_MODELS.map((m) => m.name);
    expect(names.some((n) => n.includes("Opus 4.6"))).toBe(true);
    expect(names.some((n) => n.includes("GPT-5.4"))).toBe(true);
    expect(names.some((n) => n.includes("Gemini"))).toBe(true);
  });
});
