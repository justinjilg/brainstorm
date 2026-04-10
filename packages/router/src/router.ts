import type {
  TaskProfile,
  ModelEntry,
  RoutingDecision,
  RoutingContext,
  StrategyName,
} from "@brainst0rm/shared";
import { createLogger } from "@brainst0rm/shared";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BrainstormConfig, StormFrontmatter } from "@brainst0rm/config";
import type { ProviderRegistry } from "@brainst0rm/providers";
import { classifyTask } from "./classifier.js";
import { costFirstStrategy } from "./strategies/cost-first.js";
import { qualityFirstStrategy } from "./strategies/quality-first.js";
import { createRuleBasedStrategy } from "./strategies/rule-based.js";
import { createCombinedStrategy } from "./strategies/combined.js";
import { capabilityStrategy } from "./strategies/capability.js";
import { learnedStrategy, loadStats } from "./strategies/learned.js";
import { autoStrategy } from "./strategies/auto.js";
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
    taskType: string;
  } | null = null;
  private projectHints?: StormFrontmatter["routing"];

  constructor(
    private config: BrainstormConfig,
    private registry: ProviderRegistry,
    private costTracker: CostTracker,
    stormFrontmatter?: StormFrontmatter | null,
    historicalStats?: Array<{
      taskType: string;
      modelId: string;
      successes: number;
      failures: number;
      avgLatencyMs: number;
      avgCost: number;
      samples: number;
    }>,
  ) {
    this.activeStrategy = config.general.defaultStrategy;
    const combined = createCombinedStrategy(config.routing.rules);
    this.strategies = {
      "cost-first": costFirstStrategy,
      "quality-first": qualityFirstStrategy,
      "rule-based": createRuleBasedStrategy(config.routing.rules),
      combined: combined,
      capability: capabilityStrategy,
      learned: learnedStrategy,
      auto: autoStrategy,
    };

    // Load historical routing outcomes for Thompson sampling.
    // Priority: explicit historicalStats > routing-intelligence.json (auto-loaded)
    let statsToLoad = historicalStats;
    if (!statsToLoad || statsToLoad.length === 0) {
      statsToLoad = loadRoutingIntelligenceFromDisk();
    }
    if (statsToLoad && statsToLoad.length > 0) {
      loadStats(statsToLoad);
      log.info(
        {
          entries: statsToLoad.length,
          totalSamples: statsToLoad.reduce((n, s) => n + s.samples, 0),
        },
        "Loaded historical routing outcomes for Thompson sampling",
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
    // Only apply momentum when the task type matches to avoid using a chat model for complex work
    if (
      this.momentum &&
      Date.now() - this.momentum.lastSuccess < 300_000 &&
      this.momentum.taskType === task.type
    ) {
      const momentumModel = candidates.find(
        (m) => m.id === this.momentum!.modelId,
      );
      if (momentumModel) {
        return {
          model: momentumModel,
          fallbacks: candidates
            .filter((m) => m.id !== momentumModel.id)
            .slice(0, 3),
          reason: `Momentum: ${momentumModel.name} (${this.momentum.successCount} successes, same task type)`,
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

  /** Record a successful completion — builds model momentum (scoped by task type). */
  recordSuccess(modelId: string, taskType?: string): void {
    if (this.momentum?.modelId === modelId) {
      this.momentum.successCount++;
      this.momentum.lastSuccess = Date.now();
      if (taskType) this.momentum.taskType = taskType;
    } else {
      this.momentum = {
        modelId,
        successCount: 1,
        lastSuccess: Date.now(),
        taskType: taskType ?? "unknown",
      };
    }
  }

  /** Get current model momentum for daemon intelligence. */
  getMomentum(): {
    modelId: string;
    successCount: number;
    lastSuccess: number;
    taskType: string;
  } | null {
    return this.momentum ? { ...this.momentum } : null;
  }

  /** Get recent failures for daemon intelligence. */
  getRecentFailures(): Array<{
    modelId: string;
    timestamp: number;
    error: string;
  }> {
    return [...this.recentFailures];
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

/**
 * Load routing intelligence from ~/.brainstorm/routing-intelligence.json and
 * convert to the format loadStats() expects. Returns [] if file missing/invalid.
 *
 * This closes the learning loop: trajectory analyzer writes the file after each
 * session, the router reads it on startup. Every session makes the next smarter.
 */
function loadRoutingIntelligenceFromDisk(): Array<{
  taskType: string;
  modelId: string;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  avgCost: number;
  samples: number;
}> {
  const path = join(homedir(), ".brainstorm", "routing-intelligence.json");
  if (!existsSync(path)) return [];

  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!data.models || typeof data.models !== "object") return [];

    const stats: Array<any> = [];
    for (const [modelId, model] of Object.entries(data.models as any)) {
      const m = model as any;
      if (!m.byTaskType) continue;
      for (const [taskType, t] of Object.entries(m.byTaskType as any)) {
        const tt = t as any;
        const samples = (tt.successes ?? 0) + (tt.failures ?? 0);
        if (samples === 0) continue;
        stats.push({
          taskType,
          modelId,
          successes: tt.successes ?? 0,
          failures: tt.failures ?? 0,
          avgLatencyMs: 0,
          avgCost: tt.avgCost ?? 0,
          samples,
        });
      }
    }
    return stats;
  } catch {
    return [];
  }
}
