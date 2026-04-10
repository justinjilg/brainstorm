import { describe, it, expect, beforeEach } from "vitest";
import { createCombinedStrategy } from "../strategies/combined.js";
import { loadStats, recordOutcome } from "../strategies/learned.js";
import type {
  TaskProfile,
  ModelEntry,
  RoutingContext,
  BudgetState,
} from "@brainst0rm/shared";
import type { RoutingRule } from "@brainst0rm/config";

function makeModel(
  id: string,
  overrides: Partial<ModelEntry> = {},
): ModelEntry {
  const { capabilities, pricing, limits, ...rest } = overrides;
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
      ...capabilities,
    },
    pricing: {
      inputPer1MTokens: 1.0,
      outputPer1MTokens: 3.0,
      ...pricing,
    },
    limits: {
      contextWindow: 128000,
      maxOutputTokens: 4096,
      ...limits,
    },
    status: "available",
    isLocal: false,
    lastHealthCheck: Date.now(),
    ...rest,
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

function makeContext(
  budgetOverrides: Partial<BudgetState> = {},
): RoutingContext {
  return {
    budget: {
      dailyUsed: 0,
      dailyLimit: 10,
      monthlyUsed: 0,
      monthlyLimit: 100,
      sessionUsed: 0,
      sessionLimit: 5,
      hardLimit: false,
      ...budgetOverrides,
    } as BudgetState,
    sessionCost: 0,
    conversationTokens: 0,
    userPreferences: {} as any,
    recentFailures: [],
  };
}

describe("combinedStrategy", () => {
  beforeEach(() => {
    // Reset learned strategy in-memory stats so tests are deterministic.
    // Each test opts in to learned behavior by calling recordOutcome explicitly.
    loadStats([]);
  });

  describe("rule precedence", () => {
    it("rule-based match takes precedence over complexity-based routing", () => {
      const rules: RoutingRule[] = [
        {
          match: { task: "code-generation" },
          model: "pinned-model",
        } as RoutingRule,
      ];
      const strategy = createCombinedStrategy(rules);

      const models = [
        makeModel("pinned-model", { capabilities: { qualityTier: 5 } as any }),
        makeModel("tier-1-best", {
          capabilities: { qualityTier: 1 } as any,
        }),
      ];

      // Complex task would normally go quality-first → tier-1-best.
      // But a matching rule pins it to "pinned-model".
      const task = makeTask({
        type: "code-generation",
        complexity: "complex",
      });
      const result = strategy.select(task, models, makeContext());

      expect(result).not.toBeNull();
      expect(result!.model.id).toBe("pinned-model");
      expect(result!.strategy).toBe("rule-based");
    });

    it("falls through to complexity branch when no rule matches", () => {
      const rules: RoutingRule[] = [
        {
          match: { task: "refactoring" },
          model: "refactor-bot",
        } as RoutingRule,
      ];
      const strategy = createCombinedStrategy(rules);

      const models = [
        // refactor-bot is expensive but only matches "refactoring" rule.
        makeModel("refactor-bot", {
          pricing: { inputPer1MTokens: 10, outputPer1MTokens: 30 },
          capabilities: { qualityTier: 2 } as any,
        }),
        // cheap-one must meet code-generation min quality tier (3)
        // so qualityTier must be <= 3. Cost-first then picks cheapest.
        makeModel("cheap-one", {
          pricing: { inputPer1MTokens: 0.1, outputPer1MTokens: 0.3 },
          capabilities: { qualityTier: 3, speedTier: 1 } as any,
        }),
      ];

      // Trivial task, task type does not match the "refactoring" rule → falls
      // through to cost-first (trivial branch).
      const task = makeTask({
        type: "code-generation",
        complexity: "trivial",
      });
      const result = strategy.select(task, models, makeContext());

      expect(result).not.toBeNull();
      expect(result!.strategy).toBe("cost-first");
      expect(result!.model.id).toBe("cheap-one");
    });
  });

  describe("budget pressure gate", () => {
    it("skips learned strategy when budget pressure >= 80% for simple tasks", () => {
      const strategy = createCombinedStrategy([]);

      // Populate learned stats above the threshold. Without budget pressure
      // the learned branch would be taken. Use task type "debugging" which
      // has an explicit MIN_QUALITY entry (tier 2) in cost-first, so both
      // models below are eligible.
      for (let i = 0; i < 25; i++) {
        recordOutcome("debugging", "expensive", true, 100, 0.01);
      }

      const models = [
        makeModel("expensive", {
          pricing: { inputPer1MTokens: 50, outputPer1MTokens: 100 },
          capabilities: { qualityTier: 1, speedTier: 3 } as any,
        }),
        makeModel("cheap", {
          pricing: { inputPer1MTokens: 0.1, outputPer1MTokens: 0.3 },
          capabilities: { qualityTier: 2, speedTier: 1 } as any,
        }),
      ];

      const task = makeTask({
        type: "debugging",
        complexity: "simple",
      });
      // Budget pressure: 9 / 10 = 0.9 → skips learned, falls to cost-first.
      const ctx = makeContext({ dailyUsed: 9, dailyLimit: 10 });
      const result = strategy.select(task, models, ctx);

      expect(result).not.toBeNull();
      expect(result!.strategy).toBe("cost-first");
      expect(result!.model.id).toBe("cheap");
    });

    it("treats dailyLimit=0 as no pressure (division guard)", () => {
      const strategy = createCombinedStrategy([]);

      const models = [
        // Task type defaults to MIN_QUALITY=3 in cost-first, so tier 2 passes.
        makeModel("cheap", {
          pricing: { inputPer1MTokens: 0.1, outputPer1MTokens: 0.3 },
          capabilities: { qualityTier: 2 } as any,
        }),
      ];

      // dailyLimit 0 → ternary short-circuits budgetPressure to 0. We're
      // still a trivial task with no learned samples, so should land in
      // cost-first without throwing a divide-by-zero.
      const task = makeTask({
        type: "analysis",
        complexity: "trivial",
      });
      const ctx = makeContext({ dailyUsed: 100, dailyLimit: 0 });
      const result = strategy.select(task, models, ctx);

      expect(result).not.toBeNull();
      expect(result!.strategy).toBe("cost-first");
    });
  });

  describe("learned threshold delegation", () => {
    it("delegates to learned strategy once task type crosses 20 samples", () => {
      const strategy = createCombinedStrategy([]);

      // Seed 21 outcomes for task type "summarization" (> LEARNED_THRESHOLD).
      for (let i = 0; i < 21; i++) {
        recordOutcome("summarization", "learned-pick", true, 50, 0.002);
      }

      const models = [
        makeModel("learned-pick", {
          capabilities: { qualityTier: 3 } as any,
        }),
        makeModel("other", {
          capabilities: { qualityTier: 2 } as any,
        }),
      ];

      // Complexity is "complex", which would normally land in quality-first.
      // But learned threshold is met and budget pressure is low → learned.
      const task = makeTask({
        type: "summarization" as any,
        complexity: "complex",
      });
      const result = strategy.select(task, models, makeContext());

      expect(result).not.toBeNull();
      expect(result!.strategy).toBe("learned");
      expect(result!.reason).toMatch(/Learned \(21 samples\)/);
    });

    it("does not delegate when task type has fewer than 20 samples", () => {
      const strategy = createCombinedStrategy([]);

      // Only 19 samples — below threshold.
      for (let i = 0; i < 19; i++) {
        recordOutcome("classification", "some-model", true, 10, 0.001);
      }

      const models = [
        makeModel("tier-1", { capabilities: { qualityTier: 1 } as any }),
        makeModel("tier-4", { capabilities: { qualityTier: 4 } as any }),
      ];

      const task = makeTask({
        type: "classification" as any,
        complexity: "expert",
      });
      const result = strategy.select(task, models, makeContext());

      expect(result).not.toBeNull();
      // Below threshold → falls through to quality-first for expert.
      expect(result!.strategy).toBe("quality-first");
      expect(result!.model.id).toBe("tier-1");
    });
  });

  describe("complexity-based branches", () => {
    it("routes trivial tasks to cost-first", () => {
      const strategy = createCombinedStrategy([]);
      // code-generation has MIN_QUALITY tier 3, so both models must be
      // tier <= 3 to be eligible for cost-first.
      const models = [
        makeModel("pricey", {
          pricing: { inputPer1MTokens: 20, outputPer1MTokens: 60 },
          capabilities: { qualityTier: 1 } as any,
        }),
        makeModel("dirt-cheap", {
          pricing: { inputPer1MTokens: 0.05, outputPer1MTokens: 0.1 },
          capabilities: { qualityTier: 3 } as any,
        }),
      ];
      const task = makeTask({
        type: "code-generation",
        complexity: "trivial",
      });
      const result = strategy.select(task, models, makeContext());
      expect(result!.strategy).toBe("cost-first");
      expect(result!.model.id).toBe("dirt-cheap");
    });

    it("routes expert tasks to quality-first", () => {
      const strategy = createCombinedStrategy([]);
      const models = [
        makeModel("tier-3"),
        makeModel("tier-1-champ", {
          capabilities: { qualityTier: 1, speedTier: 2 } as any,
        }),
      ];
      const task = makeTask({
        type: "code-generation",
        complexity: "expert",
      });
      const result = strategy.select(task, models, makeContext());
      expect(result!.strategy).toBe("quality-first");
      expect(result!.model.id).toBe("tier-1-champ");
    });
  });

  describe("weighted scoring for moderate tasks", () => {
    it("prefers model with affinity bonus when bestFor matches task type", () => {
      const strategy = createCombinedStrategy([]);

      // Two models with identical quality/speed/cost — only difference is
      // bestFor. The 0.15 affinity bonus should break the tie.
      const pricing = { inputPer1MTokens: 1.0, outputPer1MTokens: 3.0 };
      const capBase = { qualityTier: 3, speedTier: 3 } as any;
      const models = [
        makeModel("generalist", {
          pricing,
          capabilities: { ...capBase, bestFor: [] },
        }),
        makeModel("specialist", {
          pricing,
          capabilities: { ...capBase, bestFor: ["code-generation"] },
        }),
      ];

      const task = makeTask({
        type: "code-generation",
        complexity: "moderate",
      });
      const result = strategy.select(task, models, makeContext());

      expect(result).not.toBeNull();
      expect(result!.strategy).toBe("combined");
      expect(result!.model.id).toBe("specialist");
      expect(result!.reason).toMatch(/weighted score/);
    });

    it("weights quality more heavily than speed (0.4 vs 0.15)", () => {
      const strategy = createCombinedStrategy([]);

      // Same cost, different trade-offs.
      const pricing = { inputPer1MTokens: 1.0, outputPer1MTokens: 3.0 };
      const models = [
        // Quality 1 (best), speed 5 (slowest)
        // qualityScore = 1.0, speedScore = 0.2
        // 0.4*1.0 + 0.15*0.2 = 0.43 (ignoring costScore which is ~equal)
        makeModel("high-quality", {
          pricing,
          capabilities: { qualityTier: 1, speedTier: 5 } as any,
        }),
        // Quality 5 (worst), speed 1 (fastest)
        // qualityScore = 0.2, speedScore = 1.0
        // 0.4*0.2 + 0.15*1.0 = 0.23
        makeModel("fast-but-dumb", {
          pricing,
          capabilities: { qualityTier: 5, speedTier: 1 } as any,
        }),
      ];

      const task = makeTask({
        type: "code-generation",
        complexity: "moderate",
      });
      const result = strategy.select(task, models, makeContext());

      expect(result).not.toBeNull();
      expect(result!.model.id).toBe("high-quality");
    });

    it("returns null when no available models for moderate task", () => {
      const strategy = createCombinedStrategy([]);
      const models = [
        makeModel("down", { status: "unavailable" } as any),
        makeModel("also-down", { status: "unavailable" } as any),
      ];
      const task = makeTask({ complexity: "moderate" });
      const result = strategy.select(task, models, makeContext());
      expect(result).toBeNull();
    });

    it("includes up to 3 fallback models sorted by score", () => {
      const strategy = createCombinedStrategy([]);
      const models = [
        makeModel("a", { capabilities: { qualityTier: 1 } as any }),
        makeModel("b", { capabilities: { qualityTier: 2 } as any }),
        makeModel("c", { capabilities: { qualityTier: 3 } as any }),
        makeModel("d", { capabilities: { qualityTier: 4 } as any }),
        makeModel("e", { capabilities: { qualityTier: 5 } as any }),
      ];
      const task = makeTask({ complexity: "moderate" });
      const result = strategy.select(task, models, makeContext());

      expect(result).not.toBeNull();
      expect(result!.model.id).toBe("a");
      expect(result!.fallbacks).toHaveLength(3);
      expect(result!.fallbacks.map((m) => m.id)).toEqual(["b", "c", "d"]);
    });
  });
});
