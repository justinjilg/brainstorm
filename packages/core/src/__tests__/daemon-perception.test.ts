/**
 * Daemon perception tests — the awakening loop.
 *
 * The tick message is the daemon's senses: world state (what it can reach),
 * open drift (what disagrees with the world model), and platform events
 * (pushed perception from connected products). These tests pin:
 *   1. the tick renders perception/drift/events sections when provided
 *   2. the self-repair directive activates when notices are present
 *   3. the controller feeds providers into the tick and marks platform
 *      events consumed exactly once
 *   4. a throwing perception provider never kills the tick
 */

import { describe, expect, it } from "vitest";
import { formatTickMessage } from "../daemon/tick-message";
import { DaemonController } from "../daemon/controller";
import { createInitialState } from "../daemon/types";
import type { AgentEvent } from "@brainst0rm/shared";

const daemonConfig = {
  enabled: true,
  tickIntervalMs: 5_000,
  maxTicksPerSession: 1,
  sleepDefaultMs: 1_000,
  dailyLogDir: "/tmp/brainstorm-test-logs",
  promptCacheExpiryMs: 300_000,
  compactionThreshold: 0.6,
};

describe("tick message perception sections", () => {
  it("renders world state, drift, and platform events", () => {
    const msg = formatTickMessage({
      state: createInitialState(),
      worldState: {
        connectors: [
          {
            name: "msp",
            healthy: true,
            toolCount: 12,
            domains: ["alerts", "devices"],
          },
          { name: "vm", healthy: false, toolCount: 0 },
        ],
        br: { connected: true, models: 40, budgetRemainingUsd: 4.2 },
        project: { name: "brainstorm", onboarded: true, memoryCount: 12 },
      },
      openDrifts: [
        {
          id: "drift-1",
          kind: "customer-account",
          severity: "warn",
          summary: "MRR mismatch for account acme",
        },
      ],
      platformEvents: [
        {
          id: 7,
          source: "msp",
          eventType: "msp.alert.created",
          summary: "Disk failure predicted on host-7",
          receivedAt: Date.now() - 120_000,
        },
      ],
    });

    expect(msg).toContain('<perception connectors="2" healthy="1">');
    expect(msg).toContain("msp: healthy, 12 tools (domains: alerts, devices)");
    expect(msg).toContain("vm: UNREACHABLE");
    expect(msg).toContain(
      'connected="true" models="40" budget_remaining="$4.20"',
    );
    expect(msg).toContain(
      '<project name="brainstorm" onboarded="true" memories="12" />',
    );
    expect(msg).toContain('<drift open="1">');
    expect(msg).toContain(
      "[warn] customer-account: MRR mismatch for account acme (id=drift-1)",
    );
    expect(msg).toContain('<platform_events count="1">');
    expect(msg).toContain(
      "[msp] msp.alert.created: Disk failure predicted on host-7",
    );
    // Self-repair directive replaces the passive one when notices exist.
    expect(msg).toContain("investigate it with read-only tools first");
    expect(msg).toContain("propose a ChangeSet for anything material");
  });

  it("omits perception sections and keeps the passive directive when nothing is sensed", () => {
    const msg = formatTickMessage({ state: createInitialState() });
    expect(msg).not.toContain("<perception");
    expect(msg).not.toContain("<drift");
    expect(msg).not.toContain("<platform_events");
    expect(msg).toContain("Review the tick context above");
  });
});

describe("controller perception wiring", () => {
  function makeController(overrides: Record<string, unknown>) {
    const tickMessages: string[] = [];
    const controller = new DaemonController({
      config: daemonConfig,
      sessionId: "test-session",
      projectPath: "/tmp",
      runTick: async function* (
        tickMessage: string,
      ): AsyncGenerator<AgentEvent> {
        tickMessages.push(tickMessage);
        yield { type: "done", totalCost: 0.01, totalTokens: 10 } as AgentEvent;
      },
      ...overrides,
    });
    return { controller, tickMessages };
  }

  async function drain(controller: DaemonController) {
    const events: AgentEvent[] = [];
    for await (const event of controller.run()) {
      events.push(event);
      const t = (event as { type?: string }).type;
      // After the first tick the controller enters its inter-tick sleep
      // (without emitting an event on the cost-paced path); stop as soon as
      // the tick completes instead of waiting out the interval.
      if (t === "daemon-tick" || t === "daemon-sleep") controller.stop();
      if (t === "daemon-stopped") break;
    }
    return events;
  }

  it("feeds world state, drift, and events into the tick and marks events consumed once", async () => {
    const consumed: Array<string | number>[] = [];
    const { controller, tickMessages } = makeController({
      getWorldState: () => ({
        connectors: [{ name: "shield", healthy: true, toolCount: 4 }],
        br: { connected: false, note: "no api key" },
      }),
      getOpenDrifts: () => [
        {
          id: "d9",
          kind: "stale-artifact",
          severity: "info",
          summary: "runbook 90d old",
        },
      ],
      getPlatformEvents: () => [
        {
          id: "ev-1",
          source: "shield",
          eventType: "shield.threat.detected",
          summary: "anomalous login",
          receivedAt: Date.now(),
        },
      ],
      onPlatformEventsConsumed: (ids: Array<string | number>) => {
        consumed.push(ids);
      },
    });

    await drain(controller);

    expect(tickMessages).toHaveLength(1);
    const msg = tickMessages[0];
    expect(msg).toContain("shield: healthy, 4 tools");
    expect(msg).toContain('note="no api key"');
    expect(msg).toContain("[info] stale-artifact: runbook 90d old (id=d9)");
    expect(msg).toContain("[shield] shield.threat.detected: anomalous login");
    expect(consumed).toEqual([["ev-1"]]);
  });

  it("renders self-awareness metrics from router intelligence and cost pacing", async () => {
    const { controller, tickMessages } = makeController({
      getRouterIntelligence: () => ({
        momentum: {
          modelId: "claude-sonnet-5",
          successCount: 6,
          taskType: "code",
        },
        recentFailureCount: 0,
        convergenceAlerts: [],
      }),
      getCostPacing: (defaultMs: number) => ({
        intervalMs: defaultMs * 2,
        reason: "budget pressure",
        budgetPressure: 0.8,
        shouldStop: false,
      }),
    });

    await drain(controller);

    const msg = tickMessages[0];
    expect(msg).toContain(
      '<model id="claude-sonnet-5" momentum="strong" successes="6" />',
    );
    expect(msg).toContain("<budget_pressure>high</budget_pressure>");
    expect(msg).toContain('<cost_pacing active="true"');
  });

  it("a throwing perception provider never kills the tick", async () => {
    const { controller, tickMessages } = makeController({
      getWorldState: () => {
        throw new Error("sense failure");
      },
      getOpenDrifts: () => {
        throw new Error("sense failure");
      },
    });

    const events = await drain(controller);

    expect(tickMessages).toHaveLength(1);
    // Tick completed and daemon stopped normally (not via circuit breaker).
    const stopped = events.find(
      (e) => (e as { type?: string }).type === "daemon-stopped",
    ) as { reason?: string } | undefined;
    expect(stopped).toBeDefined();
    expect(stopped?.reason ?? "").not.toContain("Circuit breaker");
  });
});
