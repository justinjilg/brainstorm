import { describe, it, expect } from "vitest";
import { ExchangeController } from "../exchange/controller.js";
import { OrganismBus } from "../organism/bus.js";
import type { ExchangeGenerate, ExchangeEvent } from "../exchange/types.js";

/** A deterministic fake: each model returns a labeled answer of a fixed length. */
const fakeGenerate: ExchangeGenerate = async ({ model, system }) => {
  const isCritique = system.includes("reviewing peer proposals");
  // Make model "b" the shortest proposer so the vote winner is predictable.
  const text = isCritique
    ? `${model} critique`
    : model === "b"
      ? "short"
      : `${model} proposes a longer answer`;
  return { text, cost: 0.001 };
};

async function collect(
  gen: AsyncGenerator<ExchangeEvent>,
): Promise<ExchangeEvent[]> {
  const out: ExchangeEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("ExchangeController", () => {
  const spec = {
    prompt: "What is the best data structure for a LRU cache?",
    participants: [{ model: "a" }, { model: "b" }, { model: "c" }],
    reconciler: "vote" as const,
  };

  it("streams propose → critique → vote → reconciled in order", async () => {
    const bus = new OrganismBus();
    const ctrl = new ExchangeController(spec, fakeGenerate, { bus });
    const events = await collect(ctrl.run());
    const types = events.map((e) => e.type);

    expect(types[0]).toBe("exchange.started");
    expect(types.filter((t) => t === "exchange.turn-complete")).toHaveLength(3);
    expect(types.filter((t) => t === "exchange.critique")).toHaveLength(3);
    expect(types.filter((t) => t === "exchange.vote")).toHaveLength(3);
    expect(types[types.length - 1]).toBe("exchange.reconciled");

    // propose comes before critique comes before reconcile
    const firstCritique = types.indexOf("exchange.critique");
    const lastPropose = types.lastIndexOf("exchange.turn-complete");
    const reconciled = types.indexOf("exchange.reconciled");
    expect(lastPropose).toBeLessThan(firstCritique);
    expect(firstCritique).toBeLessThan(reconciled);
  });

  it("mirrors every event onto the organism bus with an actor", async () => {
    const bus = new OrganismBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    const ctrl = new ExchangeController(spec, fakeGenerate, { bus });
    await collect(ctrl.run());
    expect(seen[0]).toBe("exchange.started");
    expect(seen).toContain("exchange.reconciled");
    // The bus folds active-exchange count up on start and down on reconcile.
    expect(bus.snapshot().exchanges.active).toBe(0);
  });

  it("vote reconciler adopts the shortest proposal (ensemble selectWinner)", async () => {
    const bus = new OrganismBus();
    const ctrl = new ExchangeController(spec, fakeGenerate, { bus });
    const events = await collect(ctrl.run());
    const reconciled = events.find((e) => e.type === "exchange.reconciled");
    expect(reconciled).toMatchObject({ method: "vote", resolution: "short" });
  });

  it("aborts before reconcile when the signal is already aborted mid-run", async () => {
    const ac = new AbortController();
    const bus = new OrganismBus();
    // Abort after proposals by flipping the signal inside generate.
    let calls = 0;
    const gen: ExchangeGenerate = async ({ model }) => {
      calls++;
      if (calls >= 3) ac.abort();
      return { text: `${model} answer`, cost: 0 };
    };
    const ctrl = new ExchangeController(spec, gen, { bus, signal: ac.signal });
    const events = await collect(ctrl.run());
    const types = events.map((e) => e.type);
    expect(types).toContain("exchange.aborted");
    expect(types).not.toContain("exchange.reconciled");
  });

  it("rejects a council of fewer than two participants", () => {
    expect(
      () =>
        new ExchangeController(
          { ...spec, participants: [{ model: "solo" }] },
          fakeGenerate,
        ),
    ).toThrow(/at least 2/);
  });
});
