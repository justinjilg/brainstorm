import type {
  TaskProfile,
  ModelEntry,
  RoutingDecision,
  RoutingContext,
  StrategyName,
} from "@brainstorm/shared";
import { createLogger } from "@brainstorm/shared";
import type { BrainstormConfig, StormFrontmatter } from "@brainstorm/config";
import type { ProviderRegistry } from "@brainstorm/providers";
import { classifyTask } from "./classifier.js";
import { costFirstStrategy } from "./strategies/cost-first.js";
import { qualityFirstStrategy } from "./strategies/quality-first.js";
import { createRuleBasedStrategy } from "./strategies/rule-based.js";
import { createCombinedStrategy } from "./strategies/combined.js";
import { capabilityStrategy } from "./strategies/capability.js";
import type { RoutingStrategy } from "./strategies/types.js";
import type { CostTracker } from "./cost-tracker.js";

const log = createLogger("router");

export class BrainstormRouter {
  private strategies: Record<StrategyName, RoutingStrategy>;
  private activeStrategy: StrategyName;
  private recentFailures: Array<{
    modelId: string;
    timestamp: number;
    error: string;
  }> = [];
  private momentum: {
    modelId: string;
    successCount: number;
    lastSuccess: number;
  } | null = null;
  private projectHints?: StormFrontmatter["routing"];

  constructor(
    private config: BrainstormConfig,
    private registry: ProviderRegistry,
    private costTracker: CostTracker,
    stormFrontmatter?: StormFrontmatter | null,
  ) {
    this.activeStrategy = config.general.defaultStrategy;
    const combined = createCombinedStrategy(config.routing.rules);
    this.strategies = {
      "cost-first": costFirstStrategy,
      "quality-first": qualityFirstStrategy,
      "rule-based": createRuleBasedStrategy(config.routing.rules),
      combined: combined,
      capability: capabilityStrategy,
      learned: combined, // Falls back to combined until ONNX model is available
    };
    if (this.activeStrategy === "learned") {
      log.warn(
        "Learned routing strategy not yet available — using combined strategy",
      );
    }
    this.projectHints = stormFrontmatter?.routing;

    // Auto-activate capability strategy when eval data exists
    this.autoSelectStrategy();
  }

  /**
   * If any model in the registry has capability scores from eval,
   * auto-switch to capability strategy (unless user explicitly set something else).
   */
  autoSelectStrategy(): void {
    const hasEvalData = this.registry.models.some(
      (m) => m.capabilities.capabilityScores !== undefined,
    );
    if (hasEvalData && this.activeStrategy === "combined") {
      this.activeStrategy = "capability";
      log.info("Auto-activated capability strategy (eval data available)");
    }
  }

  classify(
    message: string,
    context?: { fileCount?: number; hasErrors?: boolean },
  ): TaskProfile {
    return classifyTask(message, context, this.projectHints);
  }

  route(
    task: TaskProfile,
    optionsOrTokens?:
      | number
      | { conversationTokens?: number; preferCheap?: boolean },
  ): RoutingDecision {
    // Check budget before routing
    this.costTracker.checkBudget();

    const opts =
      typeof optionsOrTokens === "number"
        ? { conversationTokens: optionsOrTokens, preferCheap: false }
        : {
            conversationTokens: optionsOrTokens?.conversationTokens,
            preferCheap: optionsOrTokens?.preferCheap ?? false,
          };

    const candidates = this.getEligibleModels(task);
    const context = this.buildRoutingContext(opts.conversationTokens);

    // Model momentum: if a model has been working well, stick with it (within 5 min)
    if (this.momentum && Date.now() - this.momentum.lastSuccess < 300_000) {
      const momentumModel = candidates.find(
        (m) => m.id === this.momentum!.modelId,
      );
      if (momentumModel) {
        return {
          model: momentumModel,
          fallbacks: candidates
            .filter((m) => m.id !== momentumModel.id)
            .slice(0, 3),
          reason: `Momentum: ${momentumModel.name} (${this.momentum.successCount} consecutive successes)`,
          estimatedCost: 0,
          strategy: this.activeStrategy,
        };
      }
    }

    // If preferCheap, try cost-first strategy first
    if (opts.preferCheap && this.strategies["cost-first"]) {
      const cheapDecision = this.strategies["cost-first"].select(
        task,
        candidates,
        context,
      );
      if (cheapDecision) return cheapDecision;
    }

    // Try active strategy
    const decision = this.strategies[this.activeStrategy].select(
      task,
      candidates,
      context,
    );
    if (decision) return decision;

    // Fallback: try combined if not already active
    if (this.activeStrategy !== "combined") {
      const fallback = this.strategies.combined.select(
        task,
        candidates,
        context,
      );
      if (fallback) return fallback;
    }

    // Last resort: pick any available model
    const anyModel = candidates.find((m) => m.status === "available");
    if (!anyModel) {
      throw new Error(
        "No models available. Check provider connections and configuration.",
      );
    }

    return {
      model: anyModel,
      fallbacks: candidates
        .filter((m) => m.id !== anyModel.id && m.status === "available")
        .slice(0, 3),
      reason: `Fallback: only available model is ${anyModel.name}`,
      estimatedCost: 0,
      strategy: this.activeStrategy,
    };
  }

  /** Inject agent-profile fallback chain into a routing decision. */
  applyAgentFallbacks(
    decision: RoutingDecision,
    fallbackChain: string[],
  ): RoutingDecision {
    if (fallbackChain.length === 0) return decision;
    const agentFallbacks = fallbackChain
      .map((id) => this.registry.getModel(id))
      .filter(
        (m): m is ModelEntry => m !== undefined && m.status === "available",
      );
    if (agentFallbacks.length === 0) return decision;
    return {
      ...decision,
      fallbacks: [...agentFallbacks, ...decision.fallbacks],
    };
  }

  recordFailure(modelId: string, error: string): void {
    this.recentFailures.push({ modelId, timestamp: Date.now(), error });
    // Keep only last 10 failures
    if (this.recentFailures.length > 10) this.recentFailures.shift();
    // Break momentum on failure
    if (this.momentum?.modelId === modelId) {
      this.momentum = null;
    }
  }

  /** Record a successful completion — builds model momentum. */
  recordSuccess(modelId: string): void {
    if (this.momentum?.modelId === modelId) {
      this.momentum.successCount++;
      this.momentum.lastSuccess = Date.now();
    } else {
      this.momentum = { modelId, successCount: 1, lastSuccess: Date.now() };
    }
  }

  setStrategy(name: StrategyName): void {
    this.activeStrategy = name;
  }

  getActiveStrategy(): StrategyName {
    return this.activeStrategy;
  }

  getModels(): ModelEntry[] {
    return this.registry.models;
  }

  private getEligibleModels(task: TaskProfile): ModelEntry[] {
    return this.registry.models.filter((m) => {
      // Exclude recently failed models (within 60 seconds)
      const recentFail = this.recentFailures.find(
        (f) => f.modelId === m.id && Date.now() - f.timestamp < 60_000,
      );
      if (recentFail) return false;

      // Exclude models that can't handle tool calling if needed
      if (task.requiresToolUse && !m.capabilities.toolCalling) return false;

      return true;
    });
  }

  private buildRoutingContext(conversationTokens?: number): RoutingContext {
    const budget = this.costTracker.getBudgetState();
    return {
      budget,
      sessionCost: this.costTracker.getSessionCost(),
      conversationTokens: conversationTokens ?? 0,
      userPreferences: {
        preferLocal: false,
        preferredProvider: undefined,
        excludeModels: undefined,
      },
      recentFailures: this.recentFailures,
    };
  }
}
