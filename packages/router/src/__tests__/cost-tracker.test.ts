import { describe, it, expect } from 'vitest';
import { CostTracker } from '../cost-tracker.js';

function makeMockDb() {
  const records: any[] = [];
  return {
    prepare: (sql: string) => ({
      run: (...args: any[]) => {
        if (sql.includes('INSERT')) {
          records.push({ id: records.length + 1, cost: args[7] ?? 0 });
          return { lastInsertRowid: records.length };
        }
        if (sql.includes('UPDATE')) return {};
      },
      get: (..._args: any[]) => {
        if (sql.includes('SELECT') && records.length > 0) return records[records.length - 1];
        return { total: 0 }; // Default to zero total, not null
      },
      all: () => [],
    }),
    _records: records,
  };
}

describe('CostTracker', () => {
  it('records cost from token counts and pricing', () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { hardLimit: false });

    tracker.record({
      sessionId: 'test',
      modelId: 'model-a',
      provider: 'test',
      inputTokens: 1000,
      outputTokens: 500,
      taskType: 'code-generation' as any,
      pricing: { inputPer1MTokens: 3.0, outputPer1MTokens: 15.0 },
    });

    // 1000/1M * $3 + 500/1M * $15 = $0.003 + $0.0075 = $0.0105
    expect(tracker.getSessionCost()).toBeCloseTo(0.0105, 4);
  });

  it('tracks session tokens', () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { hardLimit: false });

    tracker.record({
      sessionId: 'test', modelId: 'm', provider: 'p',
      inputTokens: 500, outputTokens: 200,
      taskType: 'code-generation' as any,
      pricing: { inputPer1MTokens: 1, outputPer1MTokens: 1 },
    });
    tracker.record({
      sessionId: 'test', modelId: 'm', provider: 'p',
      inputTokens: 300, outputTokens: 100,
      taskType: 'code-generation' as any,
      pricing: { inputPer1MTokens: 1, outputPer1MTokens: 1 },
    });

    const tokens = tracker.getSessionTokens();
    expect(tokens.input).toBe(800);
    expect(tokens.output).toBe(300);
  });

  it('getSubagentBudget returns remaining/4 when session limit exists', () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { perSession: 2.0, hardLimit: false });

    // Spend $0.50
    tracker.record({
      sessionId: 'test', modelId: 'm', provider: 'p',
      inputTokens: 100000, outputTokens: 10000,
      taskType: 'code-generation' as any,
      pricing: { inputPer1MTokens: 3, outputPer1MTokens: 15 },
    });

    const budget = tracker.getSubagentBudget();
    const remaining = 2.0 - tracker.getSessionCost();
    expect(budget).toBeCloseTo(remaining / 4, 4);
  });

  it('getSubagentBudget returns $0.50 default when no session limit', () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { hardLimit: false });
    expect(tracker.getSubagentBudget()).toBe(0.5);
  });

  it('getSubagentBudget respects override', () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { hardLimit: false });
    expect(tracker.getSubagentBudget(0.25)).toBe(0.25);
  });

  it('getBudgetState returns correct structure', () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { daily: 5, monthly: 50, perSession: 2, hardLimit: true });
    const state = tracker.getBudgetState();

    expect(state.dailyLimit).toBe(5);
    expect(state.monthlyLimit).toBe(50);
    expect(state.sessionLimit).toBe(2);
    expect(state.hardLimit).toBe(true);
    expect(state.sessionUsed).toBe(0);
  });
});
