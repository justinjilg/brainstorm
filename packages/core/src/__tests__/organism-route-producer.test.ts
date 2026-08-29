import { describe, it, expect, afterEach } from "vitest";
import type { ModelEntry, RoutingDecision } from "@brainst0rm/shared";
import {
  OrganismBus,
  setOrganismBus,
  resetOrganismBus,
  getOrganismBus,
} from "../organism/bus.js";
import { publishRouteDecision } from "../organism/bridge.js";

function fakeModel(id: string): ModelEntry {
  return {
    id,
    provider: "anthropic",
    name: id,
    capabilities: {} as ModelEntry["capabilities"],
    pricing: {} as ModelEntry["pricing"],
    limits: {} as ModelEntry["limits"],
    status: "available" as ModelEntry["status"],
    isLocal: false,
    lastHealthCheck: 0,
  };
}

function fakeDecision(): RoutingDecision {
  return {
    model: fakeModel("claude-opus-4-8"),
    fallbacks: [],
    reason: "test",
    estimatedCost: 0.03,
    strategy: "combined",
  };
}

describe("publishRouteDecision", () => {
  afterEach(() => resetOrganismBus());

  it("publishes a route.decision onto the bus with the real task type", () => {
    const bus = new OrganismBus();
    setOrganismBus(bus);
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));

    publishRouteDecision(fakeDecision(), "code");

    const snap = bus.snapshot();
    expect(seen).toEqual(["route.decision"]);
    expect(snap.routing.lastModel).toBe("claude-opus-4-8");
    expect(snap.routing.lastStrategy).toBe("combined");
    expect(snap.routing.decisions).toBe(1);
    expect(snap.cost.sessionUsed).toBeCloseTo(0.03);
  });

  it("defaults the actor to 'you' (chat), distinguishing it from the daemon", () => {
    const bus = new OrganismBus();
    setOrganismBus(bus);
    let actor = "";
    bus.subscribe((e) => (actor = e.actor));
    publishRouteDecision(fakeDecision(), "chat");
    expect(actor).toBe("you");
  });

  it("targets the process-wide singleton bus", () => {
    const bus = new OrganismBus();
    setOrganismBus(bus);
    publishRouteDecision(fakeDecision(), "code");
    expect(getOrganismBus().snapshot().routing.decisions).toBe(1);
  });
});
