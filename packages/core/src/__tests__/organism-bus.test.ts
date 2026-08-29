import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@brainst0rm/shared";
import { OrganismBus } from "../organism/bus.js";
import { agentEventToOrganism } from "../organism/bridge.js";

describe("OrganismBus", () => {
  it("stamps a monotonic seq, ts, and default actor on publish", () => {
    const bus = new OrganismBus();
    const a = bus.publish({
      type: "kairos.tick",
      tickNumber: 1,
      idleSeconds: 0,
      cost: 0.01,
      actor: "kairos",
    });
    const b = bus.publish({ type: "health.status", ok: true });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.ts).toBeTypeOf("number");
    expect(a.actor).toBe("kairos");
    expect(b.actor).toBe("system"); // defaulted when the producer omits it
    expect(bus.currentSeq()).toBe(2);
  });

  it("folds events into the materialized snapshot", () => {
    const bus = new OrganismBus();
    bus.publish({
      type: "kairos.tick",
      tickNumber: 7,
      idleSeconds: 12,
      cost: 0.05,
    });
    bus.publish({
      type: "route.decision",
      taskType: "code",
      model: "claude-opus-4-8",
      strategy: "combined",
      estimatedCost: 0.02,
    });
    bus.publish({ type: "health.sandbox", enforcement: "full" });
    const s = bus.snapshot();
    expect(s.kairos.status).toBe("running");
    expect(s.kairos.tickCount).toBe(7);
    expect(s.kairos.totalCost).toBeCloseTo(0.05);
    expect(s.kairos.sandbox).toBe("full");
    expect(s.routing.lastModel).toBe("claude-opus-4-8");
    expect(s.routing.decisions).toBe(1);
    expect(s.cost.sessionUsed).toBeCloseTo(0.02);
  });

  it("snapshot() returns a defensive copy (mutation does not leak back)", () => {
    const bus = new OrganismBus();
    bus.publish({
      type: "kairos.tick",
      tickNumber: 1,
      idleSeconds: 0,
      cost: 0,
    });
    const snap = bus.snapshot();
    snap.kairos.tickCount = 999;
    expect(bus.snapshot().kairos.tickCount).toBe(1);
  });

  it("since(seq) returns only the gapless tail after a given seq", () => {
    const bus = new OrganismBus();
    for (let i = 0; i < 5; i++) {
      bus.publish({ type: "health.status", ok: true });
    }
    const tail = bus.since(3);
    expect(tail.map((e) => e.seq)).toEqual([4, 5]);
    expect(bus.since(5)).toEqual([]);
  });

  it("subscribe() streams future events; unsubscribe stops delivery", () => {
    const bus = new OrganismBus();
    const seen: number[] = [];
    const off = bus.subscribe((e) => seen.push(e.seq));
    bus.publish({ type: "health.status", ok: true });
    bus.publish({ type: "health.status", ok: true });
    off();
    bus.publish({ type: "health.status", ok: true });
    expect(seen).toEqual([1, 2]);
  });

  it("evicts the oldest events past bufferSize but keeps seq monotonic", () => {
    const bus = new OrganismBus({ bufferSize: 3 });
    for (let i = 0; i < 6; i++) {
      bus.publish({ type: "health.status", ok: true });
    }
    // Only the last 3 remain buffered; seq keeps climbing.
    expect(bus.currentSeq()).toBe(6);
    expect(bus.since(0).map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  it("counts active exchanges up on start and down on resolve/abort", () => {
    const bus = new OrganismBus();
    bus.publish({
      type: "exchange.started",
      exchangeId: "x1",
      participants: ["a", "b"],
      prompt: "p",
    });
    expect(bus.snapshot().exchanges.active).toBe(1);
    bus.publish({
      type: "exchange.reconciled",
      exchangeId: "x1",
      resolution: "done",
      method: "vote",
    });
    expect(bus.snapshot().exchanges.active).toBe(0);
  });
});

describe("agentEventToOrganism bridge", () => {
  it("maps daemon heartbeat events to kairos.* with actor=kairos", () => {
    const tick = agentEventToOrganism({
      type: "daemon-tick",
      tickNumber: 3,
      idleSeconds: 9,
      cost: 0.04,
    } as AgentEvent);
    expect(tick).toEqual({
      type: "kairos.tick",
      tickNumber: 3,
      idleSeconds: 9,
      cost: 0.04,
      actor: "kairos",
    });

    const stopped = agentEventToOrganism({
      type: "daemon-stopped",
      tickCount: 10,
      totalCost: 1.23,
    } as AgentEvent);
    expect(stopped).toMatchObject({ type: "kairos.state", status: "stopped" });
  });

  it("returns null for chat-loop events with no organism projection", () => {
    expect(
      agentEventToOrganism({ type: "text-delta", delta: "hi" } as AgentEvent),
    ).toBeNull();
  });
});
