import type { CostRecord, TaskType, BudgetState } from "@brainstorm/shared";
import type { BudgetConfig } from "@brainstorm/config";
import { BudgetExceededError } from "@brainstorm/shared";
import { CostRepository } from "@brainstorm/db";

export class CostTracker {
  private repo: CostRepository;
  private budgetConfig: BudgetConfig;
  private sessionCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private sessionTurns = 0;

  constructor(db: any, budgetConfig: BudgetConfig) {
    this.repo = new CostRepository(db);
    this.budgetConfig = budgetConfig;
  }

  record(params: {
    sessionId: string;
    modelId: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    taskType: TaskType;
    projectPath?: string;
    pricing: { inputPer1MTokens: number; outputPer1MTokens: number };
  }): CostRecord {
    const cost =
      (params.inputTokens / 1_000_000) * params.pricing.inputPer1MTokens +
      (params.outputTokens / 1_000_000) * params.pricing.outputPer1MTokens;

    this.sessionCost += cost;
    this.sessionInputTokens += params.inputTokens;
    this.sessionOutputTokens += params.outputTokens;
    this.sessionTurns++;

    return this.repo.record({
      timestamp: Math.floor(Date.now() / 1000),
      sessionId: params.sessionId,
      modelId: params.modelId,
      provider: params.provider,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cachedTokens: params.cachedTokens ?? 0,
      cost,
      taskType: params.taskType,
      projectPath: params.projectPath,
    });
  }

  getBudgetState(): BudgetState {
    return {
      dailyUsed: this.repo.totalCostToday(),
      dailyLimit: this.budgetConfig.daily,
      monthlyUsed: this.repo.totalCostThisMonth(),
      monthlyLimit: this.budgetConfig.monthly,
      sessionUsed: this.sessionCost,
      sessionLimit: this.budgetConfig.perSession,
      hardLimit: this.budgetConfig.hardLimit,
    };
  }

  checkBudget(): void {
    const state = this.getBudgetState();

    if (state.dailyLimit && state.dailyUsed >= state.dailyLimit) {
      if (state.hardLimit)
        throw new BudgetExceededError(
          "daily",
          state.dailyUsed,
          state.dailyLimit,
        );
    }
    if (state.monthlyLimit && state.monthlyUsed >= state.monthlyLimit) {
      if (state.hardLimit)
        throw new BudgetExceededError(
          "monthly",
          state.monthlyUsed,
          state.monthlyLimit,
        );
    }
    if (state.sessionLimit && state.sessionUsed >= state.sessionLimit) {
      if (state.hardLimit)
        throw new BudgetExceededError(
          "session",
          state.sessionUsed,
          state.sessionLimit,
        );
    }
  }

  getSessionCost(): number {
    return this.sessionCost;
  }

  getSessionTokens(): { input: number; output: number } {
    return { input: this.sessionInputTokens, output: this.sessionOutputTokens };
  }

  getSummary() {
    return {
      session: this.sessionCost,
      today: this.repo.totalCostToday(),
      thisMonth: this.repo.totalCostThisMonth(),
      byModel: this.repo.recentByModel(),
      byTaskType: this.repo.byTaskType(),
    };
  }

  /** Get remaining session budget, or null if no session limit is set. */
  getRemainingBudget(): number | null {
    const sessionLimit = this.budgetConfig.perSession;
    if (!sessionLimit) return null;
    return Math.max(0, sessionLimit - this.sessionCost);
  }

  /**
   * Calculate a budget limit for a subagent.
   * Default: remaining session budget / 4, or a fixed amount if no session limit.
   */
  getSubagentBudget(overrideBudget?: number): number {
    if (overrideBudget !== undefined) return overrideBudget;
    const sessionLimit = this.budgetConfig.perSession;
    if (sessionLimit) {
      const remaining = Math.max(0, sessionLimit - this.sessionCost);
      return remaining / 4;
    }
    // No session limit — default to $0.50 per subagent
    return 0.5;
  }

  /**
   * Reconcile actual cost from gateway headers with local tracking.
   * When the gateway reports the real cost, use it instead of our estimate.
   */
  reconcile(sessionId: string, actualCost: number): void {
    const lastRecord = this.repo.lastForSession(sessionId);
    if (!lastRecord) return;

    const delta = actualCost - lastRecord.cost;
    if (Math.abs(delta) > 0.000001) {
      this.sessionCost += delta;
      this.repo.updateCost(lastRecord.id, actualCost);
    }
  }

  /**
   * Forecast total session cost based on current velocity.
   * Projects cost from average cost-per-turn over remaining estimated turns.
   */
  forecast(estimatedTotalTurns = 20): {
    currentCost: number;
    projectedCost: number;
    costPerTurn: number;
    turnsCompleted: number;
    exceedsLimit: boolean;
  } {
    const costPerTurn =
      this.sessionTurns > 0 ? this.sessionCost / this.sessionTurns : 0;
    const remainingTurns = Math.max(0, estimatedTotalTurns - this.sessionTurns);
    const projectedCost = this.sessionCost + costPerTurn * remainingTurns;
    const sessionLimit = this.budgetConfig.perSession;

    return {
      currentCost: this.sessionCost,
      projectedCost,
      costPerTurn,
      turnsCompleted: this.sessionTurns,
      exceedsLimit: sessionLimit != null && projectedCost > sessionLimit,
    };
  }
}
