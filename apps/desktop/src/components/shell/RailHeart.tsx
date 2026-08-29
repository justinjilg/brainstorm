/**
 * RailHeart — the organism, felt at the edge.
 *
 * A small breathing mark in the rail that IS the always-on signal that KAIROS is
 * alive: it breathes on a ~4s cycle when running, dims to amber when halted, and
 * carries the live tick count like an odometer. Clicking it opens the Pulse feed.
 * This is the whole "ambient, not central" contract in one control — the organism
 * glows quietly here instead of taking the canvas.
 */
import { useOrganismSelector } from "../../hooks/useOrganism";

export interface RailHeartProps {
  onOpen: () => void;
  /** True when Pulse has activity the user hasn't opened yet. */
  hasUnseen: boolean;
  active: boolean;
}

export function RailHeart({ onOpen, hasUnseen, active }: RailHeartProps) {
  // Select only the KAIROS vitals the heart shows — it must keep breathing
  // steadily, not re-render on every route/exchange event flowing through the bus.
  const { status, tickCount, connected } = useOrganismSelector(
    (o) => ({
      status: o.state.kairos.status,
      tickCount: o.state.kairos.tickCount,
      connected: o.connected,
    }),
    (a, b) =>
      a.status === b.status &&
      a.tickCount === b.tickCount &&
      a.connected === b.connected,
  );
  const halted =
    status === "halted" || status === "stopped" || status === "paused";
  const color = halted ? "var(--sig-warn)" : "var(--organism)";
  const label = connected
    ? `Pulse — KAIROS ${status} · tick ${tickCount}`
    : "Pulse — connecting to the organism…";

  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      aria-label={label}
      data-testid="rail-heart"
      className="relative flex flex-col items-center gap-1 py-2 w-full outline-none group"
      style={{
        background: active ? "var(--ctp-surface0)" : "transparent",
        borderLeft: active
          ? "2px solid var(--organism)"
          : "2px solid transparent",
      }}
    >
      <span className="relative flex items-center justify-center h-6 w-6">
        <span
          className={halted ? "" : "animate-breathe"}
          style={{
            width: 12,
            height: 12,
            borderRadius: "9999px",
            background: color,
            boxShadow: `0 0 10px ${color}, 0 0 3px ${color}`,
            transition: "background var(--duration-normal) var(--ease)",
          }}
        />
        {hasUnseen && !active && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              width: 6,
              height: 6,
              borderRadius: "9999px",
              background: "var(--organism)",
              boxShadow: `0 0 6px var(--organism)`,
            }}
          />
        )}
      </span>
      <span
        className="font-mono tabular-nums"
        style={{
          fontSize: "var(--text-2xs)",
          color: halted ? "var(--sig-warn)" : "var(--ctp-overlay1)",
          letterSpacing: "0.02em",
        }}
      >
        {connected ? tickCount : "—"}
      </span>
    </button>
  );
}
