import type { CostRecord, TaskType, BudgetState } from '@brainstorm/shared';
import type { BudgetConfig } from '@brainstorm/config';
import { BudgetExceededError } from '@brainstorm/shared';
import { CostRepository } from '@brainstorm/db';

export class CostTracker {
  private repo: CostRepository;
  private budgetConfig: BudgetConfig;
  private sessionCost = 0;

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
      if (state.hardLimit) throw new BudgetExceededError('daily', state.dailyUsed, state.dailyLimit);
    }
    if (state.monthlyLimit && state.monthlyUsed >= state.monthlyLimit) {
      if (state.hardLimit) throw new BudgetExceededError('monthly', state.monthlyUsed, state.monthlyLimit);
    }
    if (state.sessionLimit && state.sessionUsed >= state.sessionLimit) {
      if (state.hardLimit) throw new BudgetExceededError('session', state.sessionUsed, state.sessionLimit);
    }
  }

  getSessionCost(): number {
    return this.sessionCost;
  }

  getSummary() {
    return {
      session: this.sessionCost,
      today: this.repo.totalCostToday(),
      thisMonth: this.repo.totalCostThisMonth(),
      byModel: this.repo.recentByModel(),
    };
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
}
