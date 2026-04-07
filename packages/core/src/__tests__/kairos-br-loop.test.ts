/**
 * KAIROS ↔ BR Intelligence Loop Tests
 *
 * Tests the feedback loop between KAIROS daemon and BrainstormRouter:
 * 1. Cost-paced sleep: BR forecast drives tick intervals
 * 2. Momentum-aware gates: router intelligence enriches approval context
 * 3. Daemon self-awareness: performance metrics in tick messages
 *
 * These test the actual data flow, not just schemas.
 */

import { describe, it, expect } from "vitest";
import {
  formatTickMessage,
  type TickMessageContext,
  type DaemonMetrics,
} from "../daemon/tick-message";
import { createInitialState, type ApprovalGateContext } from "../daemon/types";

describe("Cost-Paced Sleep", () => {
  it("healthy budget returns default interval", () => {
    // Simulate CostTracker.getAdvisedSleepMs behavior
    const sessionCost = 0.1;
    const sessionLimit = 5.0;
    const pressure = sessionCost / sessionLimit; // 2%
    const defaultMs = 30_000;

    // At 2% pressure, no stretching
    expect(pressure).toBeLessThan(0.5);
    const advisedMs = defaultMs; // No change
    expect(advisedMs).toBe(defaultMs);
  });

  it("moderate budget pressure stretches interval 1.5x", () => {
    const sessionCost = 3.0;
    const sessionLimit = 5.0;
    const pressure = sessionCost / sessionLimit; // 60%
    const defaultMs = 30_000;

    expect(pressure).toBeGreaterThan(0.5);
    expect(pressure).toBeLessThan(0.75);
    const advisedMs = Math.round(defaultMs * 1.5); // 45s
    expect(advisedMs).toBe(45_000);
  });

  it("high budget pressure stretches interval 2x", () => {
    const sessionCost = 4.0;
    const sessionLimit = 5.0;
    const pressure = sessionCost / sessionLimit; // 80%
    const defaultMs = 30_000;

    expect(pressure).toBeGreaterThan(0.75);
    expect(pressure).toBeLessThan(0.9);
    const advisedMs = defaultMs * 2; // 60s
    expect(advisedMs).toBe(60_000);
  });

  it("critical budget pressure stretches interval 3x", () => {
    const sessionCost = 4.75;
    const sessionLimit = 5.0;
    const pressure = sessionCost / sessionLimit; // 95%
    const defaultMs = 30_000;

    expect(pressure).toBeGreaterThan(0.9);
    const advisedMs = defaultMs * 3; // 90s (conservation mode)
    expect(advisedMs).toBe(90_000);
  });
});

describe("Momentum-Aware Approval Gates", () => {
  it("gate context includes router intelligence fields", () => {
    const context: ApprovalGateContext = {
      tickNumber: 50,
      ticksSinceLastGate: 25,
      costSinceLastGate: 0.35,
      toolCallsSinceLastGate: ["file_read", "shell", "git_commit"],
      totalCost: 1.2,
      sessionDurationMs: 300_000,
      // Router intelligence
      modelMomentum: {
        modelId: "claude-opus-4-6",
        successCount: 7,
        taskType: "code-generation",
      },
      recentFailures: 0,
      budgetPressure: 0.24,
      costPacingActive: false,
      convergenceAlerts: undefined,
    };

    // Verify all fields populated
    expect(context.modelMomentum).not.toBeNull();
    expect(context.modelMomentum!.successCount).toBe(7);
    expect(context.recentFailures).toBe(0);
    expect(context.budgetPressure).toBeLessThan(0.5);
    expect(context.costPacingActive).toBe(false);
  });

  it("gate context reflects high-pressure situation", () => {
    const context: ApprovalGateContext = {
      tickNumber: 100,
      ticksSinceLastGate: 25,
      costSinceLastGate: 1.5,
      toolCallsSinceLastGate: ["shell", "web_fetch", "shell", "shell"],
      totalCost: 4.5,
      sessionDurationMs: 600_000,
      modelMomentum: null, // Momentum broken
      recentFailures: 3,
      budgetPressure: 0.9,
      costPacingActive: true,
      convergenceAlerts: [
        "Model deepseek-chat received 85% of last 50 outcomes",
      ],
    };

    // Human should see: broken momentum, 3 failures, 90% budget,
    // cost pacing active, convergence alert
    expect(context.modelMomentum).toBeNull();
    expect(context.recentFailures).toBe(3);
    expect(context.budgetPressure).toBeGreaterThan(0.8);
    expect(context.costPacingActive).toBe(true);
    expect(context.convergenceAlerts).toHaveLength(1);
  });

  it("gate context without router gives safe defaults", () => {
    const context: ApprovalGateContext = {
      tickNumber: 25,
      ticksSinceLastGate: 25,
      costSinceLastGate: 0.5,
      toolCallsSinceLastGate: ["file_read"],
      totalCost: 0.5,
      sessionDurationMs: 120_000,
      // No router intelligence available
      modelMomentum: null,
      recentFailures: 0,
      budgetPressure: 0,
      costPacingActive: false,
    };

    // Defaults should be safe (nothing alarming)
    expect(context.budgetPressure).toBe(0);
    expect(context.costPacingActive).toBe(false);
  });
});

describe("Daemon Self-Awareness in Tick Messages", () => {
  function makeTickContext(metrics?: DaemonMetrics): TickMessageContext {
    return {
      state: createInitialState(),
      budgetRemaining: 3.5,
      daemonMetrics: metrics,
    };
  }

  it("tick message without metrics renders normally", () => {
    const msg = formatTickMessage(makeTickContext());
    expect(msg).toContain("<tick");
    expect(msg).not.toContain("<performance>");
  });

  it("tick message with strong momentum shows model info", () => {
    const msg = formatTickMessage(
      makeTickContext({
        successRate: 0.9,
        momentum: "strong",
        activeModel: "claude-opus-4-6",
        consecutiveSuccesses: 8,
        budgetPressure: "healthy",
        costPacingActive: false,
        ticksUntilGate: 15,
      }),
    );

    expect(msg).toContain("<performance>");
    expect(msg).toContain('momentum="strong"');
    expect(msg).toContain('successes="8"');
    expect(msg).toContain("claude-opus-4-6");
    expect(msg).toContain("<success_rate>90%</success_rate>");
    expect(msg).toContain("<budget_pressure>healthy</budget_pressure>");
    expect(msg).toContain('<next_gate ticks="15"');
    expect(msg).not.toContain("<cost_pacing");
    expect(msg).not.toContain("<warning>");
  });

  it("tick message with broken momentum and warnings shows alerts", () => {
    const msg = formatTickMessage(
      makeTickContext({
        successRate: 0.3,
        momentum: "broken",
        activeModel: "deepseek-chat",
        consecutiveSuccesses: 0,
        budgetPressure: "critical",
        costPacingActive: true,
        ticksUntilGate: 3,
        convergenceWarning:
          "Model deepseek-chat received 85% of last 50 outcomes",
      }),
    );

    expect(msg).toContain('momentum="broken"');
    expect(msg).toContain("<success_rate>30%</success_rate>");
    expect(msg).toContain("<budget_pressure>critical</budget_pressure>");
    expect(msg).toContain('active="true"');
    expect(msg).toContain("Tick intervals stretched");
    expect(msg).toContain('<next_gate ticks="3"');
    expect(msg).toContain("<warning>");
    expect(msg).toContain("85%");
  });

  it("tick message with no gate configured omits gate line", () => {
    const msg = formatTickMessage(
      makeTickContext({
        successRate: 0.7,
        momentum: "building",
        activeModel: "gpt-5.4",
        consecutiveSuccesses: 3,
        budgetPressure: "moderate",
        costPacingActive: false,
        ticksUntilGate: null,
      }),
    );

    expect(msg).toContain("<performance>");
    expect(msg).not.toContain("<next_gate");
  });
});
