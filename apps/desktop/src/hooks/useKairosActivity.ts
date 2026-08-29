/**
 * useKairosActivity — the KAIROS-scoped view of the organism bus.
 *
 * Previously this folded raw daemon frames off `onChatEvent`; now it's a thin
 * adapter over `useOrganism()`, projecting the shared organism feed down to the
 * KAIROS narrative (wake → tick → sleep → …) the live panel renders. One
 * subscription backs the whole app; this hook just filters + shapes it.
 */

import { useOrganism } from "./useOrganism";
import { organismEventLabel, type OrganismEvent } from "../lib/organism";

export interface KairosActivityEntry {
  id: number;
  at: number;
  kind: "wake" | "tick" | "sleep" | "stopped" | "error" | "state";
  label: string;
}

export interface KairosLiveState {
  status: "running" | "sleeping" | "paused" | "stopped";
  tickCount: number;
  totalCost: number;
  lastWakeTrigger?: string;
  sleepReason?: string;
  lastTickAt?: number;
}

/** Map an organism event type onto the panel's activity `kind` (or null to skip
 * events that aren't part of the KAIROS narrative). */
function kindOf(ev: OrganismEvent): KairosActivityEntry["kind"] | null {
  switch (ev.type) {
    case "kairos.wake":
      return "wake";
    case "kairos.tick":
      return "tick";
    case "kairos.sleep":
      return "sleep";
    case "kairos.heal":
    case "kairos.commit":
      return "state";
    case "kairos.state":
      return (ev as { status?: string }).status === "stopped"
        ? "stopped"
        : "state";
    default:
      return null; // route.*, exchange.*, health.* — not the KAIROS feed
  }
}

export function useKairosActivity(): {
  feed: KairosActivityEntry[];
  live: KairosLiveState;
} {
  const { state, feed: organismFeed } = useOrganism();

  const feed: KairosActivityEntry[] = [];
  for (const ev of organismFeed) {
    const kind = kindOf(ev);
    if (!kind) continue;
    feed.push({ id: ev.seq, at: ev.ts, kind, label: organismEventLabel(ev) });
  }

  // Last wake trigger / sleep reason come off the feed (they aren't in the
  // coarse snapshot). organismFeed is newest-first, so `find` gets the latest.
  const lastWake = organismFeed.find((e) => e.type === "kairos.wake") as
    | { trigger?: string }
    | undefined;
  const lastSleep = organismFeed.find((e) => e.type === "kairos.sleep") as
    | { reason?: string }
    | undefined;

  const status: KairosLiveState["status"] =
    state.kairos.status === "running"
      ? "running"
      : state.kairos.status === "paused"
        ? "paused"
        : "stopped";

  const live: KairosLiveState = {
    status,
    tickCount: state.kairos.tickCount,
    totalCost: state.kairos.totalCost,
    lastWakeTrigger: lastWake?.trigger,
    sleepReason: lastSleep?.reason,
    lastTickAt: state.kairos.lastTickAt,
  };

  return { feed, live };
}
