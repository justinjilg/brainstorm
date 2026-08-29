/**
 * useKairosActivity — taps the live daemon event stream so the UI can SHOW the
 * self-improvement loop, not just a status dot.
 *
 * The backend forwards every daemon event to the renderer as a "chat-event"
 * with an `event` field: `daemon-wake`, `daemon-tick`, `daemon-sleep`,
 * `kairos-state` (a full DaemonState), plus `daemon-stopped`/`daemon-error`.
 * We fold those into a bounded, human-readable activity feed and the latest
 * live counters (tick #, cost, status, sleep reason).
 */

import { useEffect, useRef, useState } from "react";

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

const MAX_FEED = 40;

export function useKairosActivity() {
  const [feed, setFeed] = useState<KairosActivityEntry[]>([]);
  const [live, setLive] = useState<KairosLiveState>({
    status: "stopped",
    tickCount: 0,
    totalCost: 0,
  });
  const counter = useRef(0);

  useEffect(() => {
    if (!("brainstorm" in window) || !window.brainstorm) return;
    const push = (kind: KairosActivityEntry["kind"], label: string) =>
      setFeed((prev) =>
        [{ id: ++counter.current, at: Date.now(), kind, label }, ...prev].slice(
          0,
          MAX_FEED,
        ),
      );

    const unlisten = window.brainstorm.onChatEvent((raw: any) => {
      const ev: string | undefined = raw?.event;
      const data = raw?.data ?? {};
      switch (ev) {
        case "kairos-state":
          setLive((prev) => ({
            status: data.status ?? prev.status,
            tickCount: data.tickCount ?? prev.tickCount,
            totalCost:
              typeof data.totalCost === "number"
                ? data.totalCost
                : prev.totalCost,
            lastWakeTrigger: data.lastWakeTrigger ?? prev.lastWakeTrigger,
            sleepReason: data.sleepReason ?? prev.sleepReason,
            lastTickAt: data.lastTickAt ?? prev.lastTickAt,
          }));
          break;
        case "daemon-wake":
          push(
            "wake",
            `Woke${data.trigger ? ` (${data.trigger})` : ""} — scanning for something to harden`,
          );
          break;
        case "daemon-tick":
          push(
            "tick",
            `Tick${data.tickNumber ? ` #${data.tickNumber}` : ""}${
              data.modelUsed ? ` · ${data.modelUsed}` : ""
            }${typeof data.cost === "number" ? ` · $${data.cost.toFixed(4)}` : ""}`,
          );
          break;
        case "daemon-sleep":
          push("sleep", `Sleeping${data.reason ? ` — ${data.reason}` : ""}`);
          break;
        case "daemon-stopped":
          push("stopped", `Stopped${data.reason ? ` — ${data.reason}` : ""}`);
          break;
        case "daemon-error":
          push("error", `Error — ${data.error ?? "unknown"}`);
          break;
        default:
          break;
      }
    });
    return unlisten;
  }, []);

  return { feed, live };
}
