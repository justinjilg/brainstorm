/**
 * The organism event taxonomy — the single live stream every Brainstorm surface
 * (desktop, TUI, CLI) subscribes to instead of re-querying state over a poll.
 *
 * Six namespaces mirror the living-organism model that the UX is built around:
 * KAIROS is the heartbeat (`kairos.*`), BrainstormRouter is the nervous system
 * (`route.*`), models-talking-to-models is deliberation (`exchange.*`), your work
 * is `chat.*`, and the anatomy/vitals are `memory.*` / `health.*`.
 *
 * Every event is plain, JSON-serializable data — these cross the IPC and SSE
 * boundaries as NDJSON frames, so no `Error` objects or class instances. A
 * producer emits a bare {@link OrganismEventInput}; the {@link OrganismBus}
 * stamps a monotonic `seq`, a wall-clock `ts`, and an `actor` on publish.
 */

export type OrganismNamespace =
  | "kairos"
  | "route"
  | "exchange"
  | "chat"
  | "memory"
  | "health";

/** The daemon's autonomy state as the UX renders it (the rail-heart mood). */
export type KairosStatus = "idle" | "running" | "paused" | "stopped" | "halted";

// ── kairos.* — the self-improvement heartbeat ────────────────────────────────
export type KairosEvent =
  | {
      type: "kairos.tick";
      tickNumber: number;
      idleSeconds: number;
      cost: number;
    }
  | { type: "kairos.sleep"; sleepMs: number; reason: string }
  | { type: "kairos.wake"; trigger: "timer" | "user" | "scheduler" }
  | { type: "kairos.heal"; summary: string; branch?: string }
  | {
      type: "kairos.commit";
      sha: string;
      message: string;
      branch: string;
      verified: boolean;
    }
  | {
      type: "kairos.proposal";
      id: string;
      summary: string;
      needsApproval: boolean;
    }
  | {
      type: "kairos.state";
      status: KairosStatus;
      tickCount: number;
      totalCost: number;
    };

// ── route.* — the nervous system (BR routing) ────────────────────────────────
export type RouteEvent =
  | {
      type: "route.decision";
      taskType: string;
      model: string;
      /** Provider family, carried from the ModelEntry so presentation never has
       * to infer it from the model id. */
      provider?: string;
      strategy: string;
      estimatedCost: number;
      cache?: "hit" | "miss";
    }
  | {
      type: "route.outcome";
      taskType: string;
      model: string;
      success: boolean;
      latencyMs: number;
      cost: number;
    };

// ── exchange.* — models talking to models (wired in Phase 3, typed now) ───────
export type ExchangeEvent =
  | {
      type: "exchange.started";
      exchangeId: string;
      participants: string[];
      prompt: string;
    }
  | { type: "exchange.turn-delta"; exchangeId: string; delta: string }
  | {
      type: "exchange.turn-complete";
      exchangeId: string;
      text: string;
      round: "propose" | "critique" | "reconcile";
    }
  | {
      type: "exchange.critique";
      exchangeId: string;
      target: string;
      text: string;
    }
  | { type: "exchange.vote"; exchangeId: string; choice: string }
  | {
      type: "exchange.reconciled";
      exchangeId: string;
      resolution: string;
      method: "vote" | "judge" | "owner";
    }
  | { type: "exchange.aborted"; exchangeId: string; reason: string };

// ── chat.* — your work (the loop itself stays on AgentEvent; the bus mirrors
//    only the lifecycle markers a surface needs to reflect activity) ───────────
export type ChatEvent =
  | { type: "chat.started"; conversationId: string; model: string }
  | { type: "chat.done"; conversationId: string; totalCost: number };

// ── memory.* — what it has learned/become ────────────────────────────────────
export type MemoryEvent =
  | {
      type: "memory.extracted";
      memoryType: string;
      source: string;
      summary: string;
    }
  | { type: "memory.promoted"; id: string }
  | { type: "memory.quarantined"; id: string };

// ── health.* — vitals ────────────────────────────────────────────────────────
export type HealthEvent =
  | { type: "health.status"; ok: boolean; detail?: string }
  | { type: "health.sandbox"; enforcement: "full" | "none"; clonePath?: string }
  | { type: "health.budget"; used: number; limit?: number; percent: number };

/** The bare event a producer emits (may optionally name its `actor`). */
export type OrganismEventInput = (
  | KairosEvent
  | RouteEvent
  | ExchangeEvent
  | ChatEvent
  | MemoryEvent
  | HealthEvent
) & {
  /**
   * Who produced it — "you", a model id, "kairos", "system". Team seam: rooms
   * don't change when teammates arrive, this column just gains values.
   */
  actor?: string;
};

/** An event once published: the input plus the bus-stamped envelope fields. */
export type OrganismEvent = OrganismEventInput & {
  /** Monotonic per-bus sequence number — the basis for gapless resume. */
  seq: number;
  /** Wall-clock time the bus stamped on publish. */
  ts: number;
  actor: string;
};

/** The namespace of an event, derived from its dotted `type`. */
export function organismNamespace(ev: { type: string }): OrganismNamespace {
  return ev.type.split(".")[0] as OrganismNamespace;
}

/**
 * The materialized snapshot a subscriber receives before the live stream —
 * folded from every published event so a late joiner sees current state without
 * replaying history.
 */
export interface OrganismState {
  kairos: {
    status: KairosStatus;
    tickCount: number;
    totalCost: number;
    lastTickAt?: number;
    branch?: string;
    sandbox: "full" | "none" | "unknown";
  };
  routing: {
    lastModel?: string;
    lastStrategy?: string;
    decisions: number;
    lastDecisionAt?: number;
  };
  exchanges: {
    active: number;
    lastExchangeId?: string;
  };
  cost: {
    sessionUsed: number;
    dailyUsed?: number;
    dailyLimit?: number;
  };
  health: {
    ok: boolean;
    detail?: string;
  };
  memoryStats: {
    total: number;
  };
}

/** A fresh, zeroed snapshot — the state before any event is folded in. */
export function initialOrganismState(): OrganismState {
  return {
    kairos: { status: "idle", tickCount: 0, totalCost: 0, sandbox: "unknown" },
    routing: { decisions: 0 },
    exchanges: { active: 0 },
    cost: { sessionUsed: 0 },
    health: { ok: true },
    memoryStats: { total: 0 },
  };
}

/**
 * Fold one event into a snapshot, mutating it in place. The SINGLE source of
 * truth for the projection, shared by the server-side {@link OrganismState}
 * materializer (the bus) and every client that keeps vitals live between
 * snapshots (the desktop `useOrganism` hook) — so the two can never drift.
 */
export function foldOrganismState(s: OrganismState, ev: OrganismEvent): void {
  switch (ev.type) {
    case "kairos.tick":
      s.kairos.status = "running";
      s.kairos.tickCount = ev.tickNumber;
      s.kairos.totalCost += ev.cost;
      s.kairos.lastTickAt = ev.ts;
      break;
    case "kairos.sleep":
    case "kairos.wake":
      if (s.kairos.status === "idle" || s.kairos.status === "stopped") {
        s.kairos.status = "running";
      }
      break;
    case "kairos.commit":
      s.kairos.branch = ev.branch;
      break;
    case "kairos.state":
      s.kairos.status = ev.status;
      s.kairos.tickCount = ev.tickCount;
      s.kairos.totalCost = ev.totalCost;
      break;
    case "route.decision":
      s.routing.lastModel = ev.model;
      s.routing.lastStrategy = ev.strategy;
      s.routing.decisions += 1;
      s.routing.lastDecisionAt = ev.ts;
      // Estimate accrues at decision time; the later outcome carries the real
      // cost but we don't double-count it into the live session total.
      s.cost.sessionUsed += ev.estimatedCost;
      break;
    case "exchange.started":
      s.exchanges.active += 1;
      s.exchanges.lastExchangeId = ev.exchangeId;
      break;
    case "exchange.reconciled":
    case "exchange.aborted":
      s.exchanges.active = Math.max(0, s.exchanges.active - 1);
      break;
    case "health.status":
      s.health.ok = ev.ok;
      s.health.detail = ev.detail;
      break;
    case "health.sandbox":
      s.kairos.sandbox = ev.enforcement;
      break;
    case "health.budget":
      s.cost.dailyUsed = ev.used;
      s.cost.dailyLimit = ev.limit;
      break;
    case "memory.extracted":
      s.memoryStats.total += 1;
      break;
    default:
      // Streamed to subscribers but not folded into the coarse snapshot:
      // route.outcome, exchange.turn-*/critique/vote, chat.*,
      // memory.promoted/quarantined, kairos.heal/proposal.
      break;
  }
}
