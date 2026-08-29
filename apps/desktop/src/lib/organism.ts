/**
 * Renderer-side mirror of the organism event taxonomy + state fold.
 *
 * This is a deliberate local mirror of `@brainst0rm/shared/organism-events`,
 * following the same convention this app already uses for `AgentEvent` in
 * `api-client.ts`: the renderer never imports workspace runtime modules (the
 * shared barrel pulls Node-only deps like pino, a Vite bundling hazard), so the
 * pure projection lives here. Keep {@link foldOrganism} in lockstep with the
 * server's `foldOrganismState` — the shared unit test guards the source of truth.
 */

export type KairosStatus = "idle" | "running" | "paused" | "stopped" | "halted";

/** An event once published by the bus: envelope + payload. Loosely typed on the
 * payload so the feed can render any event; the fold reads only known fields. */
export interface OrganismEvent {
  type: string;
  seq: number;
  ts: number;
  actor: string;
  [key: string]: unknown;
}

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
  exchanges: { active: number; lastExchangeId?: string };
  cost: { sessionUsed: number; dailyUsed?: number; dailyLimit?: number };
  health: { ok: boolean; detail?: string };
  memoryStats: { total: number };
}

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
 * A fixed-shape shallow clone of the snapshot — O(1), no generic deep-clone.
 * Used per streamed event instead of `structuredClone(state)` so a high event
 * rate (e.g. exchange turn-deltas) doesn't pay a deep-clone tax; each nested
 * object is a fresh reference so React sees the change.
 */
export function cloneState(s: OrganismState): OrganismState {
  return {
    kairos: { ...s.kairos },
    routing: { ...s.routing },
    exchanges: { ...s.exchanges },
    cost: { ...s.cost },
    health: { ...s.health },
    memoryStats: { ...s.memoryStats },
  };
}

/** Mirror of the server's `foldOrganismState`. Mutates `s` in place. */
export function foldOrganism(s: OrganismState, ev: OrganismEvent): void {
  const d = ev as Record<string, unknown>;
  switch (ev.type) {
    case "kairos.tick":
      s.kairos.status = "running";
      s.kairos.tickCount = Number(d.tickNumber ?? s.kairos.tickCount);
      s.kairos.totalCost += Number(d.cost ?? 0);
      s.kairos.lastTickAt = ev.ts;
      break;
    case "kairos.sleep":
    case "kairos.wake":
      if (s.kairos.status === "idle" || s.kairos.status === "stopped") {
        s.kairos.status = "running";
      }
      break;
    case "kairos.commit":
      s.kairos.branch = String(d.branch ?? s.kairos.branch ?? "");
      break;
    case "kairos.state":
      s.kairos.status = (d.status as KairosStatus) ?? s.kairos.status;
      s.kairos.tickCount = Number(d.tickCount ?? s.kairos.tickCount);
      s.kairos.totalCost = Number(d.totalCost ?? s.kairos.totalCost);
      break;
    case "route.decision":
      s.routing.lastModel = String(d.model ?? s.routing.lastModel ?? "");
      s.routing.lastStrategy = String(
        d.strategy ?? s.routing.lastStrategy ?? "",
      );
      s.routing.decisions += 1;
      s.routing.lastDecisionAt = ev.ts;
      s.cost.sessionUsed += Number(d.estimatedCost ?? 0);
      break;
    case "exchange.started":
      s.exchanges.active += 1;
      s.exchanges.lastExchangeId = String(d.exchangeId ?? "");
      break;
    case "exchange.reconciled":
    case "exchange.aborted":
      s.exchanges.active = Math.max(0, s.exchanges.active - 1);
      break;
    case "health.status":
      s.health.ok = Boolean(d.ok);
      s.health.detail = d.detail as string | undefined;
      break;
    case "health.sandbox":
      s.kairos.sandbox = (d.enforcement as "full" | "none") ?? s.kairos.sandbox;
      break;
    case "health.budget":
      s.cost.dailyUsed = Number(d.used ?? s.cost.dailyUsed ?? 0);
      s.cost.dailyLimit = d.limit as number | undefined;
      break;
    case "memory.extracted":
      s.memoryStats.total += 1;
      break;
    default:
      break;
  }
}

/** A short human label for an event, for the activity feed. */
export function organismEventLabel(ev: OrganismEvent): string {
  const d = ev as Record<string, unknown>;
  switch (ev.type) {
    case "kairos.tick":
      return `Tick #${d.tickNumber ?? "?"}${
        typeof d.cost === "number" ? ` · $${(d.cost as number).toFixed(4)}` : ""
      }`;
    case "kairos.sleep":
      return `Sleeping${d.reason ? ` — ${d.reason}` : ""}`;
    case "kairos.wake":
      return `Woke${d.trigger ? ` (${d.trigger})` : ""}`;
    case "kairos.heal":
      return `Healing — ${d.summary ?? ""}`;
    case "kairos.commit":
      return `Committed ${String(d.sha ?? "").slice(0, 7)} — ${d.message ?? ""}`;
    case "kairos.state":
      return `KAIROS ${d.status ?? ""}`;
    case "route.decision":
      return `Routed → ${d.model ?? "?"} (${d.strategy ?? "?"})`;
    case "route.outcome":
      return `Outcome ${d.success ? "✓" : "✗"} ${d.model ?? ""}`;
    case "exchange.started":
      return `Council convened (${
        Array.isArray(d.participants)
          ? (d.participants as unknown[]).length
          : "?"
      } models)`;
    case "exchange.reconciled":
      return `Council resolved (${d.method ?? ""})`;
    case "health.sandbox":
      return `Sandbox: ${d.enforcement ?? ""}`;
    case "health.status":
      return d.ok ? "Healthy" : `Unhealthy — ${d.detail ?? ""}`;
    default:
      return ev.type;
  }
}
