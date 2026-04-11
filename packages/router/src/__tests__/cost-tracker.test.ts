import { describe, it, expect } from "vitest";
import { CostTracker } from "../cost-tracker.js";

function makeMockDb() {
  const records: any[] = [];
  return {
    prepare: (sql: string) => ({
      run: (...args: any[]) => {
        if (sql.includes("INSERT")) {
          records.push({ id: records.length + 1, cost: args[7] ?? 0 });
          return { lastInsertRowid: records.length };
        }
        if (sql.includes("UPDATE")) return {};
      },
      get: (..._args: any[]) => {
        if (sql.includes("SELECT") && records.length > 0)
          return records[records.length - 1];
        return { total: 0 }; // Default to zero total, not null
      },
      all: () => [],
    }),
    _records: records,
  };
}

describe("CostTracker", () => {
  it("records cost from token counts and pricing", () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { hardLimit: false });

    tracker.record({
      sessionId: "test",
      modelId: "model-a",
      provider: "test",
      inputTokens: 1000,
      outputTokens: 500,
      taskType: "code-generation" as any,
      pricing: { inputPer1MTokens: 3.0, outputPer1MTokens: 15.0 },
    });

    // 1000/1M * $3 + 500/1M * $15 = $0.003 + $0.0075 = $0.0105
    expect(tracker.getSessionCost()).toBeCloseTo(0.0105, 4);
  });

  it("tracks session tokens", () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { hardLimit: false });

    tracker.record({
      sessionId: "test",
      modelId: "m",
      provider: "p",
      inputTokens: 500,
      outputTokens: 200,
      taskType: "code-generation" as any,
      pricing: { inputPer1MTokens: 1, outputPer1MTokens: 1 },
    });
    tracker.record({
      sessionId: "test",
      modelId: "m",
      provider: "p",
      inputTokens: 300,
      outputTokens: 100,
      taskType: "code-generation" as any,
      pricing: { inputPer1MTokens: 1, outputPer1MTokens: 1 },
    });

    const tokens = tracker.getSessionTokens();
    expect(tokens.input).toBe(800);
    expect(tokens.output).toBe(300);
  });

  it("getSubagentBudget returns remaining/4 when session limit exists", () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, {
      perSession: 2.0,
      hardLimit: false,
    });

    // Spend $0.50
    tracker.record({
      sessionId: "test",
      modelId: "m",
      provider: "p",
      inputTokens: 100000,
      outputTokens: 10000,
      taskType: "code-generation" as any,
      pricing: { inputPer1MTokens: 3, outputPer1MTokens: 15 },
    });

    const budget = tracker.getSubagentBudget();
    const remaining = 2.0 - tracker.getSessionCost();
    expect(budget).toBeCloseTo(remaining / 4, 4);
  });

  it("getSubagentBudget returns $0.50 default when no session limit", () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { hardLimit: false });
    expect(tracker.getSubagentBudget()).toBe(0.5);
  });

  it("getSubagentBudget respects override", () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, { hardLimit: false });
    expect(tracker.getSubagentBudget(0.25)).toBe(0.25);
  });

  it("getBudgetState returns correct structure", () => {
    const db = makeMockDb();
    const tracker = new CostTracker(db as any, {
      daily: 5,
      monthly: 50,
      perSession: 2,
      hardLimit: true,
    });
    const state = tracker.getBudgetState();

    expect(state.dailyLimit).toBe(5);
    expect(state.monthlyLimit).toBe(50);
    expect(state.sessionLimit).toBe(2);
    expect(state.hardLimit).toBe(true);
    expect(state.sessionUsed).toBe(0);
  });

  describe("diagnoseBudgetAtStartup", () => {
    /**
     * Build a mock db whose totalCostToday / totalCostThisMonth queries
     * return fixed values, so we can simulate pre-existing spend from
     * earlier sessions — the scenario that tripped Dogfood #1 Bug 4.
     *
     * Both queries use the same SQL with a timestamp threshold as the
     * argument, so we distinguish by comparing the threshold to today's
     * midnight: earlier = monthly (month-start), later = daily (day-start).
     */
    function mockDbWithSpend(dailySpend: number, monthlySpend: number): any {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const dayThreshold = Math.floor(startOfDay.getTime() / 1000);
      return {
        prepare: (sql: string) => ({
          run: () => ({ lastInsertRowid: 0 }),
          get: (arg?: unknown) => {
            if (typeof arg === "number" && sql.includes("timestamp")) {
              // Daily query uses today's midnight, monthly uses month-start
              return arg >= dayThreshold
                ? { total: dailySpend }
                : { total: monthlySpend };
            }
            return { total: 0 };
          },
          all: () => [],
        }),
      };
    }

    it("returns null when budget is healthy", () => {
      const tracker = new CostTracker(mockDbWithSpend(1.0, 10.0), {
        daily: 5,
        monthly: 50,
        hardLimit: true,
      });
      expect(tracker.diagnoseBudgetAtStartup()).toBeNull();
    });

    it("returns error severity when daily cap already exceeded with hardLimit", () => {
      const tracker = new CostTracker(mockDbWithSpend(34.55, 60.0), {
        daily: 5,
        hardLimit: true,
      });
      const diag = tracker.diagnoseBudgetAtStartup();
      expect(diag).not.toBeNull();
      expect(diag?.severity).toBe("error");
      expect(diag?.message).toContain("daily cap already exceeded");
      expect(diag?.message).toContain("$34.55");
      expect(diag?.message).toContain("$5.00");
      expect(diag?.message).toContain("session will fail");
    });

    it("returns warn severity when daily cap exceeded without hardLimit", () => {
      const tracker = new CostTracker(mockDbWithSpend(6.0, 10.0), {
        daily: 5,
        hardLimit: false,
      });
      const diag = tracker.diagnoseBudgetAtStartup();
      expect(diag?.severity).toBe("warn");
    });

    it("returns warn severity when daily usage at ≥90% but not over", () => {
      const tracker = new CostTracker(mockDbWithSpend(4.5, 10.0), {
        daily: 5,
        hardLimit: true,
      });
      const diag = tracker.diagnoseBudgetAtStartup();
      expect(diag).not.toBeNull();
      expect(diag?.severity).toBe("warn");
      expect(diag?.message).toContain("daily usage at 90%");
    });

    it("surfaces monthly cap exceedance too", () => {
      const tracker = new CostTracker(mockDbWithSpend(0, 100.0), {
        monthly: 50,
        hardLimit: true,
      });
      const diag = tracker.diagnoseBudgetAtStartup();
      expect(diag?.severity).toBe("error");
      expect(diag?.message).toContain("monthly cap already exceeded");
    });

    it("returns null when no caps are configured", () => {
      const tracker = new CostTracker(mockDbWithSpend(1000, 10000), {
        hardLimit: false,
      });
      expect(tracker.diagnoseBudgetAtStartup()).toBeNull();
    });
  });
});
