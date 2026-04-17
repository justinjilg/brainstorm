/**
 * ProviderTopology — a radial SVG view of where routing decisions go.
 *
 * A central "Brainstorm" hub node in the middle; provider nodes spaced
 * evenly around it. Every RoutingDecision captured in App.tsx increments
 * a counter on its provider node and briefly illuminates the edge from
 * the hub to that provider. Over time the edge weights settle into a
 * living picture of which providers the router favors right now.
 *
 * This is the "signature visual moment" for the desktop app — a chart
 * you won't find on a generic AI tooling dashboard. Pure inline SVG so
 * it scales and styles through the same --paint / --bone tokens as
 * everything else in the BR parity layer; no canvas, no force library.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { RoutingDecision } from "./DashboardView";

interface ProviderTopologyProps {
  decisions: RoutingDecision[];
  /** Viewport size — the radial layout rescales to fit. */
  width?: number;
  height?: number;
}

type ProviderSpec = {
  id: string;
  label: string;
  color: string;
};

// Known providers in the order we want them arranged around the hub.
// Unknown providers get appended after these as they appear in decisions.
const KNOWN_PROVIDERS: ProviderSpec[] = [
  { id: "anthropic", label: "Anthropic", color: "var(--paint-lavender)" },
  { id: "openai", label: "OpenAI", color: "var(--paint-moss)" },
  { id: "google", label: "Google", color: "var(--paint-slate)" },
  { id: "deepseek", label: "DeepSeek", color: "var(--paint-teal)" },
  { id: "local", label: "Local", color: "var(--paint-cream)" },
  { id: "moonshot", label: "Moonshot", color: "var(--paint-clay)" },
  { id: "gateway", label: "Gateway", color: "var(--paint-brass)" },
];

export function ProviderTopology({
  decisions,
  width = 640,
  height = 400,
}: ProviderTopologyProps) {
  const providers = useMemo(() => resolveProviders(decisions), [decisions]);

  // Map provider id → { count, lastDecisionAt }. Derived from the full
  // decision list on every render; cheap for N≤200 (the ring-buffer cap
  // in App.tsx).
  const stats = useMemo(() => {
    const map = new Map<string, { count: number; lastAt: number }>();
    for (const d of decisions) {
      const id = (d.provider ?? "").toLowerCase() || "unknown";
      const cur = map.get(id) ?? { count: 0, lastAt: 0 };
      cur.count += 1;
      cur.lastAt = Math.max(cur.lastAt, d.timestamp);
      map.set(id, cur);
    }
    return map;
  }, [decisions]);

  const total = decisions.length;

  // Flash effect: when the newest decision changes, toggle a flash timer
  // on the corresponding edge. Stored per-provider so simultaneous
  // decisions against different providers don't clobber each other.
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const lastSeenRef = useRef<string | null>(null);

  useEffect(() => {
    const latest = decisions[decisions.length - 1];
    if (!latest) return;
    if (latest.id === lastSeenRef.current) return;
    lastSeenRef.current = latest.id;

    const pid = (latest.provider ?? "").toLowerCase() || "unknown";
    setFlashing((prev) => {
      const next = new Set(prev);
      next.add(pid);
      return next;
    });
    const timer = setTimeout(() => {
      setFlashing((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
    }, 900);
    return () => clearTimeout(timer);
  }, [decisions]);

  const cx = width / 2;
  const cy = height / 2;
  // Ring radius chosen so provider labels sit comfortably inside the
  // viewport with 40px of padding on all sides.
  const ringR = Math.min(width, height) / 2 - 60;
  const hubR = 28;
  const providerR = 12;

  return (
    <div
      data-testid="provider-topology"
      style={{
        position: "relative",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "var(--space-2) 0",
      }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height="auto"
        style={{ maxWidth: width, overflow: "visible" }}
        role="img"
        aria-label="Provider topology — routing decisions from Brainstorm to each provider"
      >
        <defs>
          <radialGradient id="topo-hub-halo" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="var(--bone)" stopOpacity="0.25" />
            <stop offset="60%" stopColor="var(--bone)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="var(--bone)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Soft halo so the hub reads as the origin point. */}
        <circle cx={cx} cy={cy} r={hubR * 3.2} fill="url(#topo-hub-halo)" />

        {/* Edges hub → provider. Stroke opacity scales with share of
             routing decisions so dominant providers read as the thicker,
             brighter connectors. */}
        {providers.map((p, i) => {
          const { x, y } = polarTo(cx, cy, ringR, i, providers.length);
          const pct = total > 0 ? (stats.get(p.id)?.count ?? 0) / total : 0;
          const baseOpacity = 0.1 + pct * 0.6;
          const isFlashing = flashing.has(p.id);
          return (
            <line
              key={`edge-${p.id}`}
              x1={cx}
              y1={cy}
              x2={x}
              y2={y}
              stroke={p.color}
              strokeWidth={1 + pct * 3}
              strokeOpacity={isFlashing ? 1 : baseOpacity}
              strokeLinecap="round"
              style={{
                transition:
                  "stroke-opacity 700ms var(--ease), stroke-width 400ms var(--ease)",
              }}
            />
          );
        })}

        {/* Provider nodes — disc + label + count chip. */}
        {providers.map((p, i) => {
          const { x, y } = polarTo(cx, cy, ringR, i, providers.length);
          const count = stats.get(p.id)?.count ?? 0;
          const isFlashing = flashing.has(p.id);
          const quadrant = quadrantFor(x, y, cx, cy);
          return (
            <g key={`node-${p.id}`} data-testid={`topology-provider-${p.id}`}>
              {isFlashing ? (
                <circle
                  cx={x}
                  cy={y}
                  r={providerR + 6}
                  fill={p.color}
                  fillOpacity={0.25}
                >
                  <animate
                    attributeName="r"
                    from={providerR + 2}
                    to={providerR + 14}
                    dur="0.7s"
                    fill="freeze"
                  />
                  <animate
                    attributeName="fill-opacity"
                    from={0.45}
                    to={0}
                    dur="0.7s"
                    fill="freeze"
                  />
                </circle>
              ) : null}
              <circle
                cx={x}
                cy={y}
                r={providerR}
                fill={count > 0 ? p.color : "var(--ink-3)"}
                stroke={p.color}
                strokeWidth={1.25}
                fillOpacity={count > 0 ? 0.88 : 0.25}
              />
              {/* Label */}
              <text
                x={x + labelOffsetX(quadrant, providerR)}
                y={y + labelOffsetY(quadrant, providerR)}
                textAnchor={labelAnchor(quadrant)}
                dominantBaseline={labelBaseline(quadrant)}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  fill: "var(--bone-dim)",
                }}
              >
                {p.label}
              </text>
              {count > 0 ? (
                <text
                  x={x + labelOffsetX(quadrant, providerR)}
                  y={y + labelOffsetY(quadrant, providerR) + 14}
                  textAnchor={labelAnchor(quadrant)}
                  dominantBaseline={labelBaseline(quadrant)}
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: 18,
                    fontWeight: 460,
                    letterSpacing: "-0.02em",
                    fill: "var(--bone)",
                  }}
                >
                  {count}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* Central hub */}
        <circle
          cx={cx}
          cy={cy}
          r={hubR}
          fill="var(--ink-1)"
          stroke="var(--bone)"
          strokeWidth={1.5}
        />
        <circle
          cx={cx}
          cy={cy}
          r={hubR * 0.3}
          fill="var(--bone)"
          className="animate-pulse-glow"
        />
        <text
          x={cx}
          y={cy + hubR + 22}
          textAnchor="middle"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            fill: "var(--bone-mute)",
          }}
        >
          Brainstorm
        </text>
        <text
          x={cx}
          y={cy + hubR + 40}
          textAnchor="middle"
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 22,
            fontWeight: 460,
            letterSpacing: "-0.02em",
            fill: "var(--bone)",
          }}
        >
          {total}
        </text>
        <text
          x={cx}
          y={cy + hubR + 56}
          textAnchor="middle"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            fill: "var(--bone-mute)",
          }}
        >
          Decisions captured
        </text>
      </svg>
    </div>
  );
}

// ── Geometry helpers ────────────────────────────────────────────────

function polarTo(
  cx: number,
  cy: number,
  r: number,
  i: number,
  total: number,
): { x: number; y: number } {
  // Start at 12 o'clock and walk clockwise; -PI/2 puts the first node
  // at the top so the layout reads as a compass rather than an oddly-
  // rotated clock.
  const angle = (2 * Math.PI * i) / total - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

type Quadrant = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

function quadrantFor(x: number, y: number, cx: number, cy: number): Quadrant {
  const dx = x - cx;
  const dy = y - cy;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = east
  if (angle >= -22.5 && angle < 22.5) return "E";
  if (angle >= 22.5 && angle < 67.5) return "SE";
  if (angle >= 67.5 && angle < 112.5) return "S";
  if (angle >= 112.5 && angle < 157.5) return "SW";
  if (angle >= 157.5 || angle < -157.5) return "W";
  if (angle >= -157.5 && angle < -112.5) return "NW";
  if (angle >= -112.5 && angle < -67.5) return "N";
  return "NE";
}

function labelOffsetX(q: Quadrant, r: number): number {
  if (q === "E" || q === "NE" || q === "SE") return r + 8;
  if (q === "W" || q === "NW" || q === "SW") return -(r + 8);
  return 0;
}
function labelOffsetY(q: Quadrant, r: number): number {
  if (q === "N") return -(r + 8);
  if (q === "S") return r + 8;
  return 0;
}
function labelAnchor(q: Quadrant): "start" | "middle" | "end" {
  if (q === "E" || q === "NE" || q === "SE") return "start";
  if (q === "W" || q === "NW" || q === "SW") return "end";
  return "middle";
}
function labelBaseline(q: Quadrant): "middle" | "alphabetic" | "hanging" {
  // React's SVG types accept the full DOMDocument set but disallow
  // "baseline" — "alphabetic" is the canonical value for bottom-of-
  // cap-height alignment.
  if (q === "N") return "alphabetic";
  if (q === "S") return "hanging";
  return "middle";
}

// ── Provider resolution ─────────────────────────────────────────────

function resolveProviders(decisions: RoutingDecision[]): ProviderSpec[] {
  // Always render the known providers so the layout is stable when the
  // decision count is low. Append any previously-unseen providers we
  // observed in the decisions list (preserves insertion order).
  const seen = new Set<string>(KNOWN_PROVIDERS.map((p) => p.id));
  const extras: ProviderSpec[] = [];
  for (const d of decisions) {
    const id = (d.provider ?? "").toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    extras.push({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      color: "var(--bone-dim)",
    });
  }
  return [...KNOWN_PROVIDERS, ...extras];
}
