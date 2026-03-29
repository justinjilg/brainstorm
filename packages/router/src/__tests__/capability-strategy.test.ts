import { describe, it, expect } from "vitest";
import { capabilityStrategy } from "../strategies/capability.js";
import type {
  TaskProfile,
  ModelEntry,
  RoutingContext,
  BudgetState,
} from "@brainstorm/shared";

function makeModel(
  id: string,
  overrides: Partial<ModelEntry> = {},
): ModelEntry {
  return {
    id,
    provider: "test",
    name: id,
    capabilities: {
      toolCalling: true,
      streaming: true,
      vision: false,
      reasoning: false,
      contextWindow: 128000,
      qualityTier: 3,
      speedTier: 3,
      bestFor: [],
      ...overrides.capabilities,
    },
    pricing: {
      inputPer1MTokens: 1.0,
      outputPer1MTokens: 3.0,
      ...overrides.pricing,
    },
    limits: {
      contextWindow: 128000,
      maxOutputTokens: 4096,
      ...overrides.limits,
    },
    status: "available",
    isLocal: false,
    lastHealthCheck: Date.now(),
    ...overrides,
  } as ModelEntry;
}

function makeTask(overrides: Partial<TaskProfile> = {}): TaskProfile {
  return {
    type: "code-generation",
    complexity: "moderate",
    estimatedTokens: { input: 1000, output: 2000 },
    requiresToolUse: true,
    requiresReasoning: false,
    ...overrides,
  } as TaskProfile;
}

function makeContext(): RoutingContext {
  return {
    budget: {
      dailyUsed: 0,
      dailyLimit: 10,
      monthlyUsed: 0,
      monthlyLimit: 100,
      sessionUsed: 0,
      sessionLimit: 5,
      hardLimit: false,
    } as BudgetState,
    sessionCost: 0,
    conversationTokens: 0,
    userPreferences: {} as any,
    recentFailures: [],
  };
}

describe("capabilityStrategy", () => {
  it("selects model with highest capability score for code-generation", () => {
    const models = [
      makeModel("weak", {
        capabilities: {
          capabilityScores: {
            toolSelection: 0.3,
            toolSequencing: 0.3,
            codeGeneration: 0.3,
            multiStepReasoning: 0.3,
            instructionFollowing: 0.3,
            contextUtilization: 0.3,
            selfCorrection: 0.3,
          },
        } as any,
      }),
      makeModel("strong", {
        capabilities: {
          capabilityScores: {
            toolSelection: 0.9,
            toolSequencing: 0.9,
            codeGeneration: 0.95,
            multiStepReasoning: 0.9,
            instructionFollowing: 0.9,
            contextUtilization: 0.9,
            selfCorrection: 0.9,
          },
        } as any,
      }),
    ];
    const task = makeTask({ type: "code-generation" });
    const result = capabilityStrategy.select(task, models, makeContext());
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("strong");
  });

  it("breaks ties on cost — cheaper model wins when capability scores are equal", () => {
    const scores = {
      toolSelection: 0.8,
      toolSequencing: 0.8,
      codeGeneration: 0.8,
      multiStepReasoning: 0.8,
      instructionFollowing: 0.8,
      contextUtilization: 0.8,
      selfCorrection: 0.8,
    };
    const models = [
      makeModel("expensive", {
        capabilities: { capabilityScores: scores } as any,
        pricing: { inputPer1MTokens: 10, outputPer1MTokens: 30 },
      }),
      makeModel("cheap", {
        capabilities: { capabilityScores: scores } as any,
        pricing: { inputPer1MTokens: 0.5, outputPer1MTokens: 1.5 },
      }),
    ];
    const result = capabilityStrategy.select(makeTask(), models, makeContext());
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("cheap");
  });

  it("assigns default 0.5 score to models without eval data", () => {
    const models = [
      makeModel("evaluated", {
        capabilities: {
          capabilityScores: {
            toolSelection: 0.9,
            toolSequencing: 0.9,
            codeGeneration: 0.9,
            multiStepReasoning: 0.9,
            instructionFollowing: 0.9,
            contextUtilization: 0.9,
            selfCorrection: 0.9,
          },
        } as any,
      }),
      makeModel("unevaluated"), // no capabilityScores → default 0.5
    ];
    const result = capabilityStrategy.select(makeTask(), models, makeContext());
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("evaluated");
  });

  it("returns null when no models available", () => {
    const result = capabilityStrategy.select(makeTask(), [], makeContext());
    expect(result).toBeNull();
  });

  it("includes fallback models in the decision", () => {
    const models = [
      makeModel("best", {
        capabilities: {
          capabilityScores: {
            toolSelection: 0.95,
            toolSequencing: 0.95,
            codeGeneration: 0.95,
            multiStepReasoning: 0.95,
            instructionFollowing: 0.95,
            contextUtilization: 0.95,
            selfCorrection: 0.95,
          },
        } as any,
      }),
      makeModel("good", {
        capabilities: {
          capabilityScores: {
            toolSelection: 0.8,
            toolSequencing: 0.8,
            codeGeneration: 0.8,
            multiStepReasoning: 0.8,
            instructionFollowing: 0.8,
            contextUtilization: 0.8,
            selfCorrection: 0.8,
          },
        } as any,
      }),
      makeModel("ok", {
        capabilities: {
          capabilityScores: {
            toolSelection: 0.6,
            toolSequencing: 0.6,
            codeGeneration: 0.6,
            multiStepReasoning: 0.6,
            instructionFollowing: 0.6,
            contextUtilization: 0.6,
            selfCorrection: 0.6,
          },
        } as any,
      }),
    ];
    const result = capabilityStrategy.select(makeTask(), models, makeContext());
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("best");
    expect(result!.fallbacks.length).toBeGreaterThanOrEqual(1);
  });
});
