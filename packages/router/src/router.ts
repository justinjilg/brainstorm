import type { TaskProfile, ModelEntry, RoutingDecision, RoutingContext, StrategyName } from '@brainstorm/shared';
import { createLogger } from '@brainstorm/shared';
import type { BrainstormConfig } from '@brainstorm/config';
import type { ProviderRegistry } from '@brainstorm/providers';
import { classifyTask } from './classifier.js';
import { costFirstStrategy } from './strategies/cost-first.js';
import { qualityFirstStrategy } from './strategies/quality-first.js';
import { createRuleBasedStrategy } from './strategies/rule-based.js';
import { createCombinedStrategy } from './strategies/combined.js';
import type { RoutingStrategy } from './strategies/types.js';
import type { CostTracker } from './cost-tracker.js';

const log = createLogger('router');

export class BrainstormRouter {
  private strategies: Record<StrategyName, RoutingStrategy>;
  private activeStrategy: StrategyName;
  private recentFailures: Array<{ modelId: string; timestamp: number; error: string }> = [];

  constructor(
    private config: BrainstormConfig,
    private registry: ProviderRegistry,
    private costTracker: CostTracker,
  ) {
    this.activeStrategy = config.general.defaultStrategy;
    const combined = createCombinedStrategy(config.routing.rules);
    this.strategies = {
      'cost-first': costFirstStrategy,
      'quality-first': qualityFirstStrategy,
      'rule-based': createRuleBasedStrategy(config.routing.rules),
      'combined': combined,
      'learned': combined, // Falls back to combined until ONNX model is available
    };
    if (this.activeStrategy === 'learned') {
      log.warn('Learned routing strategy not yet available — using combined strategy');
    }
  }

  classify(message: string, context?: { fileCount?: number; hasErrors?: boolean }): TaskProfile {
    return classifyTask(message, context);
  }

  route(task: TaskProfile): RoutingDecision {
    // Check budget before routing
    this.costTracker.checkBudget();

    const candidates = this.getEligibleModels(task);
    const context = this.buildRoutingContext();

    // Try active strategy
    const decision = this.strategies[this.activeStrategy].select(task, candidates, context);
    if (decision) return decision;

    // Fallback: try combined if not already active
    if (this.activeStrategy !== 'combined') {
      const fallback = this.strategies.combined.select(task, candidates, context);
      if (fallback) return fallback;
    }

    // Last resort: pick any available model
    const anyModel = candidates.find((m) => m.status === 'available');
    if (!anyModel) {
      throw new Error('No models available. Check provider connections and configuration.');
    }

    return {
      model: anyModel,
      fallbacks: [],
      reason: `Fallback: only available model is ${anyModel.name}`,
      estimatedCost: 0,
      strategy: this.activeStrategy,
    };
  }

  recordFailure(modelId: string, error: string): void {
    this.recentFailures.push({ modelId, timestamp: Date.now(), error });
    // Keep only last 10 failures
    if (this.recentFailures.length > 10) this.recentFailures.shift();
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

  private buildRoutingContext(): RoutingContext {
    const budget = this.costTracker.getBudgetState();
    return {
      budget,
      sessionCost: this.costTracker.getSessionCost(),
      conversationTokens: 0, // TODO: track from session
      userPreferences: {
        preferLocal: false,
        preferredProvider: undefined,
        excludeModels: undefined,
      },
      recentFailures: this.recentFailures,
    };
  }
}
