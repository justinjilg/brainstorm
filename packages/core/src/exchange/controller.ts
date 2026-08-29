/**
 * ExchangeController — runs one deliberation as a stream of `exchange.*` events.
 *
 * propose → critique → reconcile. Each event is published to the organism bus
 * (so Council + Pulse light up live) AND yielded to the direct consumer (so the
 * IPC/CLI caller can stream it). Best-effort bus publishing never breaks the run.
 *
 * Reuses `selectWinner` (ensemble voting) for the "vote" reconciler and the
 * `buildSelfReviewPrompt` critique framing generalized from self→peer review.
 */
import { randomUUID } from "node:crypto";
import type { ExchangeEvent, OrganismEventInput } from "@brainst0rm/shared";
import { getOrganismBus, type OrganismBus } from "../organism/bus.js";
import { selectWinner, type EnsembleCandidate } from "../agent/ensemble.js";
import {
  type ExchangeGenerate,
  type ExchangeProposal,
  type ExchangeResult,
  type ExchangeRound,
  type ExchangeSpec,
} from "./types.js";

export interface ExchangeControllerOptions {
  /** Bus to publish to; defaults to the process-wide organism bus. */
  bus?: OrganismBus;
  signal?: AbortSignal;
}

const DEFAULT_ROUNDS: ExchangeRound[] = ["propose", "critique", "reconcile"];

export class ExchangeController {
  private readonly id: string;
  private readonly bus: OrganismBus;
  private readonly rounds: ExchangeRound[];
  private totalCost = 0;

  constructor(
    private readonly spec: ExchangeSpec,
    private readonly generate: ExchangeGenerate,
    private readonly opts: ExchangeControllerOptions = {},
  ) {
    if (spec.participants.length < 2) {
      throw new Error("Exchange needs at least 2 participants");
    }
    this.id = spec.exchangeId ?? `xch-${randomUUID().slice(0, 8)}`;
    this.bus = opts.bus ?? getOrganismBus();
    this.rounds = spec.rounds ?? DEFAULT_ROUNDS;
  }

  get exchangeId(): string {
    return this.id;
  }

  /** Publish to the bus (best-effort) AND return the event for yielding. */
  private emit(ev: ExchangeEvent, actor: string): ExchangeEvent {
    try {
      this.bus.publish({ ...ev, actor } as OrganismEventInput);
    } catch {
      /* bus must never break a deliberation */
    }
    return ev;
  }

  private overBudget(): boolean {
    return (
      typeof this.spec.budgetCap === "number" &&
      this.totalCost >= this.spec.budgetCap
    );
  }

  async *run(): AsyncGenerator<ExchangeEvent> {
    const { participants, prompt } = this.spec;
    const signal = this.opts.signal;

    yield this.emit(
      {
        type: "exchange.started",
        exchangeId: this.id,
        participants: participants.map((p) => p.model),
        prompt,
      },
      "you",
    );

    // ── propose ──────────────────────────────────────────────────────────────
    const proposals: ExchangeProposal[] = [];
    const proposeResults = await Promise.all(
      participants.map(async (p) => {
        const r = await this.generate({
          model: p.model,
          system:
            "You are one voice in a council of models. Give your best, concise answer to the question. Stand behind it; another model will critique it.",
          prompt,
          signal,
        });
        return { p, r };
      }),
    );
    for (const { p, r } of proposeResults) {
      const cost = r.cost ?? 0;
      this.totalCost += cost;
      proposals.push({
        model: p.model,
        provider: p.provider,
        text: r.text,
        cost,
      });
      yield this.emit(
        {
          type: "exchange.turn-complete",
          exchangeId: this.id,
          text: r.text,
          round: "propose",
        },
        p.model,
      );
    }

    if (signal?.aborted || this.overBudget()) {
      return yield* this.finish(proposals, true);
    }

    // ── critique ─────────────────────────────────────────────────────────────
    if (this.rounds.includes("critique")) {
      const critiques = await Promise.all(
        participants.map(async (p) => {
          const others = proposals.filter((x) => x.model !== p.model);
          const peers = others
            .map((o, i) => `Proposal ${i + 1} (from ${o.model}):\n${o.text}`)
            .join("\n\n");
          const r = await this.generate({
            model: p.model,
            system:
              "You are reviewing peer proposals in a council. Point out the single strongest weakness or gap in the peers' answers, briefly and specifically. Be a tough but fair critic.",
            prompt: `The question was:\n${prompt}\n\nPeer proposals:\n${peers}\n\nYour critique:`,
            signal,
          });
          return { p, text: r.text, cost: r.cost ?? 0 };
        }),
      );
      for (const c of critiques) {
        this.totalCost += c.cost;
        yield this.emit(
          {
            type: "exchange.critique",
            exchangeId: this.id,
            target: "peers",
            text: c.text,
          },
          c.p.model,
        );
      }
    }

    if (signal?.aborted || this.overBudget()) {
      return yield* this.finish(proposals, true);
    }

    // ── reconcile ────────────────────────────────────────────────────────────
    return yield* this.reconcile(proposals);
  }

  private async *reconcile(
    proposals: ExchangeProposal[],
  ): AsyncGenerator<ExchangeEvent> {
    const method = this.spec.reconciler ?? "vote";

    if (method === "owner") {
      // The owner decides — surface the proposals and stop.
      yield this.emit(
        {
          type: "exchange.reconciled",
          exchangeId: this.id,
          resolution: "Awaiting the owner's decision among the proposals.",
          method: "owner",
        },
        "you",
      );
      return yield* this.finish(proposals, false, "owner");
    }

    if (method === "judge") {
      // A designated reconciler (the first participant) synthesizes a verdict.
      const judge = this.spec.participants[0];
      const all = proposals
        .map((o, i) => `Proposal ${i + 1} (from ${o.model}):\n${o.text}`)
        .join("\n\n");
      const r = await this.generate({
        model: judge.model,
        system:
          "You are the reconciler for a council of models. Synthesize the single best answer from the proposals, resolving disagreements. Output only the reconciled answer.",
        prompt: `Question:\n${this.spec.prompt}\n\nProposals:\n${all}\n\nReconciled answer:`,
        signal: this.opts.signal,
      });
      this.totalCost += r.cost ?? 0;
      yield this.emit(
        {
          type: "exchange.reconciled",
          exchangeId: this.id,
          resolution: r.text,
          method: "judge",
        },
        judge.model,
      );
      return yield* this.finish(proposals, false, "judge");
    }

    // vote (default): reuse the ensemble winner selection over the proposals.
    const candidates: EnsembleCandidate[] = proposals.map((p) => ({
      model: p.model,
      provider: p.provider,
      text: p.text,
      tokenCount: Math.ceil(p.text.length / 4),
      latencyMs: 0,
      cost: p.cost,
    }));
    const winner = selectWinner(candidates, "shortest");
    for (const p of proposals) {
      yield this.emit(
        {
          type: "exchange.vote",
          exchangeId: this.id,
          choice: winner.winner.model,
        },
        p.model,
      );
    }
    yield this.emit(
      {
        type: "exchange.reconciled",
        exchangeId: this.id,
        resolution: winner.winner.text,
        method: "vote",
      },
      "you",
    );
    return yield* this.finish(proposals, false, "vote");
  }

  /** Terminal generator step — no more events; returns the result via return value. */
  private async *finish(
    proposals: ExchangeProposal[],
    aborted: boolean,
    method: ExchangeResult["method"] = "vote",
  ): AsyncGenerator<ExchangeEvent, ExchangeResult> {
    if (aborted) {
      yield this.emit(
        {
          type: "exchange.aborted",
          exchangeId: this.id,
          reason: this.opts.signal?.aborted ? "aborted" : "budget cap reached",
        },
        "you",
      );
    }
    const resolution =
      proposals.length > 0 ? proposals[proposals.length - 1].text : "";
    return {
      exchangeId: this.id,
      resolution,
      method,
      proposals,
      totalCost: this.totalCost,
      aborted,
    };
  }
}
