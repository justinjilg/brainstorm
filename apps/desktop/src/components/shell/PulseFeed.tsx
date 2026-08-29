/**
 * PulseFeed — the organism, when you ask for it.
 *
 * Per the owner's direction, Pulse is an OPENABLE slide-over, not a central
 * dashboard: it overlays the calm Talk canvas via the rail-heart or ⌘0, opens on
 * the activity ledger first (the "Changelog of Self"), and keeps the mesh behind
 * an expand. Everything here is 100% bus-driven (`useOrganism`) — nothing polls.
 * The Redirect line maps the owner's three verbs onto real controls: nudge (wake),
 * redirect (a persisted standing directive), halt (stop) — the organism you tend.
 */
import { useEffect, useMemo, useState } from "react";
import { useOrganism } from "../../hooks/useOrganism";
import { useKairos } from "../../hooks/useKairos";
import { organismEventLabel, type OrganismEvent } from "../../lib/organism";
import { ProviderTopology } from "../dashboard/ProviderTopology";
import type { RoutingDecision } from "../dashboard/DashboardView";

const DIRECTIVE_KEY = "brainstorm.desktop.standingDirective";

function routeDecisionsFromFeed(feed: OrganismEvent[]): RoutingDecision[] {
  return feed
    .filter((e) => e.type === "route.decision")
    .slice(0, 60)
    .map((e) => {
      const d = e as unknown as Record<string, unknown>;
      const model = String(d.model ?? "?");
      return {
        id: `route-${e.seq}`,
        timestamp: e.ts,
        modelName: model,
        // Provider is carried on the event (from the ModelEntry upstream); the
        // view never infers routing domain knowledge. Unknown only for a legacy
        // buffered event that predates the typed field.
        provider: (d.provider as string | undefined) ?? "unknown",
        strategy: d.strategy as string | undefined,
        cost:
          typeof d.estimatedCost === "number"
            ? (d.estimatedCost as number)
            : undefined,
      };
    });
}

function kindColor(type: string): string {
  if (type.startsWith("kairos.commit") || type === "kairos.heal")
    return "var(--organism)";
  if (type.startsWith("exchange")) return "var(--paint-lavender)";
  if (type.startsWith("route")) return "var(--paint-teal)";
  if (type.startsWith("health") && type.includes("sandbox"))
    return "var(--sig-warn)";
  return "var(--ctp-overlay1)";
}

export interface PulseFeedProps {
  open: boolean;
  onClose: () => void;
  /** Called when the feed is opened so the rail can clear its unseen marker. */
  onSeen: () => void;
}

export function PulseFeed({ open, onClose, onSeen }: PulseFeedProps) {
  const { state, feed, connected } = useOrganism();
  const kairos = useKairos();
  const [meshOpen, setMeshOpen] = useState(false);
  const [directive, setDirective] = useState(() => {
    try {
      return localStorage.getItem(DIRECTIVE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [directiveDraft, setDirectiveDraft] = useState(directive);

  useEffect(() => {
    if (open) onSeen();
  }, [open, feed.length, onSeen]);

  const decisions = useMemo(() => routeDecisionsFromFeed(feed), [feed]);
  const k = state.kairos;
  const halted =
    k.status === "halted" || k.status === "stopped" || k.status === "paused";

  const saveDirective = () => {
    setDirective(directiveDraft);
    try {
      localStorage.setItem(DIRECTIVE_KEY, directiveDraft);
    } catch {
      /* storage may be unavailable */
    }
  };

  if (!open) return null;

  return (
    <>
      {/* scrim */}
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.35)",
          zIndex: 40,
        }}
      />
      <aside
        data-testid="pulse-feed"
        className="animate-slide-in-right"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(440px, 92vw)",
          zIndex: 41,
          display: "flex",
          flexDirection: "column",
          background: "var(--ctp-mantle)",
          borderLeft: "1px solid var(--border-subtle)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        {/* Header + vitals */}
        <header
          className="shrink-0 px-4 pt-3 pb-3"
          style={{ borderBottom: "1px solid var(--border-subtle)" }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={halted ? "" : "animate-breathe"}
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "9999px",
                  background: halted ? "var(--sig-warn)" : "var(--organism)",
                  boxShadow: `0 0 10px ${halted ? "var(--sig-warn)" : "var(--organism)"}`,
                }}
              />
              <span
                className="uppercase tracking-[0.18em]"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-subtext0)",
                }}
              >
                Pulse
              </span>
            </div>
            <button
              onClick={onClose}
              className="opacity-60 hover:opacity-100"
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ctp-overlay1)",
              }}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
          <div
            className="mt-3 grid grid-cols-4 gap-2 font-mono tabular-nums"
            style={{ fontSize: "var(--text-2xs)" }}
          >
            <Vital label="tick" value={connected ? String(k.tickCount) : "—"} />
            <Vital label="spend" value={`$${k.totalCost.toFixed(3)}`} />
            <Vital
              label="sandbox"
              value={k.sandbox}
              tone={
                k.sandbox === "full"
                  ? "ok"
                  : k.sandbox === "none"
                    ? "warn"
                    : "mute"
              }
            />
            <Vital label="routes" value={String(state.routing.decisions)} />
          </div>
          {k.branch && (
            <div
              className="mt-2 font-mono"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              branch {k.branch}
            </div>
          )}
        </header>

        {/* Redirect line — nudge / redirect / halt */}
        <div
          className="shrink-0 px-4 py-3"
          style={{ borderBottom: "1px solid var(--border-subtle)" }}
        >
          <div className="flex items-center gap-1.5">
            <input
              value={directiveDraft}
              onChange={(e) => setDirectiveDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveDirective();
              }}
              placeholder="Set a standing directive…"
              className="flex-1 px-2 py-1.5 rounded outline-none"
              style={{
                background: "var(--ctp-base)",
                border: "1px solid var(--border-subtle)",
                fontSize: "var(--text-xs)",
                color: "var(--ctp-text)",
              }}
            />
            <RedirectBtn
              label="Redirect"
              onClick={saveDirective}
              accent="var(--organism)"
            />
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            {halted ? (
              <RedirectBtn
                label="Nudge (wake)"
                onClick={kairos.start}
                accent="var(--organism)"
              />
            ) : (
              <RedirectBtn
                label="Nudge"
                onClick={kairos.resume}
                accent="var(--paint-teal)"
              />
            )}
            <RedirectBtn
              label="Halt"
              onClick={kairos.stop}
              accent="var(--sig-warn)"
            />
          </div>
          {directive && (
            <div
              className="mt-2"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-subtext0)",
              }}
            >
              Standing directive:{" "}
              <span style={{ color: "var(--ctp-text)" }}>{directive}</span>
            </div>
          )}
        </div>

        {/* Activity ledger — the Changelog of Self, opens first */}
        <div
          className="flex-1 overflow-y-auto px-2 py-2"
          data-testid="pulse-ledger"
        >
          {feed.length === 0 && (
            <div
              className="px-2 py-6 text-center"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              {connected
                ? "Quiet. The organism is idle — nudge it above."
                : "Connecting to the organism…"}
            </div>
          )}
          {feed.map((e) => (
            <div
              key={e.seq}
              className="animate-fade-in flex items-start gap-2 px-2 py-1.5"
              style={{ fontSize: "var(--text-xs)" }}
            >
              <span
                aria-hidden
                className="mt-1.5 shrink-0"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "9999px",
                  background: kindColor(e.type),
                }}
              />
              <div className="min-w-0 flex-1">
                <div style={{ color: "var(--ctp-text)" }} className="truncate">
                  {organismEventLabel(e)}
                </div>
                <div
                  className="font-mono"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ctp-overlay0)",
                  }}
                >
                  {e.actor} · {new Date(e.ts).toLocaleTimeString()}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* The mesh — behind an expand, never the wallpaper */}
        <div
          className="shrink-0"
          style={{ borderTop: "1px solid var(--border-subtle)" }}
        >
          <button
            onClick={() => setMeshOpen((v) => !v)}
            className="w-full px-4 py-2 flex items-center justify-between"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-subtext0)",
            }}
          >
            <span className="uppercase tracking-[0.15em]">
              The mesh · {decisions.length} routes
            </span>
            <span>{meshOpen ? "▾" : "▸"}</span>
          </button>
          {meshOpen && (
            <div className="px-2 pb-3" style={{ height: 220 }}>
              {decisions.length > 0 ? (
                <ProviderTopology decisions={decisions} height={210} />
              ) : (
                <div
                  className="h-full flex items-center justify-center"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ctp-overlay0)",
                  }}
                >
                  No routes yet — the mesh lights up as models are chosen.
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function Vital({
  label,
  value,
  tone = "mute",
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "mute";
}) {
  const color =
    tone === "ok"
      ? "var(--organism)"
      : tone === "warn"
        ? "var(--sig-warn)"
        : "var(--ctp-text)";
  return (
    <div className="flex flex-col">
      <span style={{ color: "var(--ctp-overlay0)" }}>{label}</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}

function RedirectBtn({
  label,
  onClick,
  accent,
}: {
  label: string;
  onClick: () => void;
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1.5 rounded hover:brightness-125"
      style={{
        fontSize: "var(--text-2xs)",
        background: "var(--ctp-surface0)",
        border: `1px solid ${accent}`,
        color: accent,
      }}
    >
      {label}
    </button>
  );
}
