/**
 * StatCard — a single instrument panel inside a StatsRow.
 *
 * Mono uppercase label + Fraunces numeral + optional trend chip +
 * optional sparkline. Accent color drives the 3px left border.
 * Hover raises a very small lift — no color change, no border flip.
 *
 * Update cycle:
 *  - `value` change → stat-value-flash animation (600ms).
 *  - `trend`/`sparkline` updates are purely declarative.
 */

import { useEffect, useRef, type ReactNode } from "react";

export type StatAccent = "accent" | "success" | "danger" | "info" | "warning";

export interface Trend {
  direction: "up" | "down" | "flat";
  label: string;
}

export interface StatCardProps {
  label: string;
  value: string;
  icon?: ReactNode;
  accent?: StatAccent;
  tooltip?: string;
  trend?: Trend | null;
  /** 7-to-30 point mini line — values are in numeric units, the
   *  component rescales to the svg bounding box. */
  sparkline?: number[];
  /** Override sparkline stroke. Defaults to the accent color. */
  sparklineColor?: string;
}

const accentCssVar: Record<StatAccent, string> = {
  accent: "var(--bone)",
  success: "var(--sig-ok)",
  danger: "var(--sig-err)",
  info: "var(--sig-info)",
  warning: "var(--sig-warn)",
};

export function StatCard({
  label,
  value,
  icon,
  accent = "accent",
  tooltip,
  trend,
  sparkline,
  sparklineColor,
}: StatCardProps) {
  const valueRef = useRef<HTMLDivElement | null>(null);
  const prevValueRef = useRef(value);

  useEffect(() => {
    if (prevValueRef.current === value) return;
    prevValueRef.current = value;
    const node = valueRef.current;
    if (!node) return;
    // Restart the animation. remove + force-reflow + re-add.
    node.classList.remove("stat-value-flash");
    void node.offsetWidth;
    node.classList.add("stat-value-flash");
  }, [value]);

  const sparklinePath = useSparkPath(sparkline);

  const extraAttr = tooltip
    ? { "data-tooltip": tooltip, tabIndex: 0 }
    : undefined;

  return (
    <div className={`stat-card stat-card-${accent}`} {...extraAttr}>
      <div className="stat-label">
        {icon ? (
          <span className="stat-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        <span>{label}</span>
      </div>
      <div className="stat-value" ref={valueRef}>
        {value}
      </div>
      {trend ? (
        <div className="stat-trend">
          <span className={`stat-trend-${trend.direction}`}>
            {trend.direction === "up"
              ? "\u2191 "
              : trend.direction === "down"
                ? "\u2193 "
                : "\u2192 "}
            {trend.label}
          </span>
        </div>
      ) : null}
      {sparklinePath ? (
        <div className="stat-sparkline-slot">
          <svg
            viewBox="0 0 300 64"
            preserveAspectRatio="none"
            className="stat-sparkline"
            aria-hidden
          >
            <path
              d={sparklinePath.area}
              fill={sparklineColor ?? accentCssVar[accent]}
              fillOpacity={0.08}
            />
            <path
              d={sparklinePath.line}
              fill="none"
              stroke={sparklineColor ?? accentCssVar[accent]}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      ) : null}
    </div>
  );
}

function useSparkPath(
  points: number[] | undefined,
): { line: string; area: string } | null {
  if (!points || points.length < 2) return null;
  const w = 300;
  const h = 64;
  const pad = 2;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);

  const line = points
    .map((p, i) => {
      const x = pad + i * step;
      const y = pad + (h - pad * 2) - ((p - min) / range) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const lastX = (pad + (points.length - 1) * step).toFixed(1);
  const area = `${line} L${lastX},${h} L${pad},${h} Z`;
  return { line, area };
}

/** Container for a row of StatCards with the BR 1px inter-card separator. */
export function StatsRow({ children }: { children: ReactNode }) {
  return <div className="stats-row">{children}</div>;
}
