/**
 * KairosLivePanel — the visible heartbeat of the self-improvement daemon.
 *
 * Shows, live: a pulsing "alive" core, the tick counter climbing, accrued cost,
 * the current status/wake trigger, and a scrolling feed of what KAIROS is
 * doing (wake → tick → sleep). This is the answer to "nothing is happening that
 * I can see": the daemon's activity, surfaced.
 */
import { useKairosActivity } from "../hooks/useKairosActivity";
import { useKairos } from "../hooks/useKairos";

const KIND_GLYPH: Record<string, string> = {
  wake: "⚡", // ⚡
  tick: "⚙", // ⚙
  sleep: "☽", // ☽
  stopped: "■", // ■
  error: "✕", // ✕
  state: "·",
};

const KIND_COLOR: Record<string, string> = {
  wake: "#7ee787",
  tick: "#79c0ff",
  sleep: "#8b949e",
  stopped: "#f0883e",
  error: "#ff7b72",
  state: "#8b949e",
};

export function KairosLivePanel() {
  const { feed, live } = useKairosActivity();
  // Polled status/tickCount/cost — reliable even right after a UI reload, when
  // no daemon event has arrived yet. The event feed adds the live narrative.
  const polled = useKairos();
  const status = polled.status !== "stopped" ? polled.status : live.status;
  const tickCount = Math.max(polled.tickCount, live.tickCount);
  const totalCost = Math.max(polled.totalCost, live.totalCost);
  const running = status === "running";
  const active = status === "running" || status === "sleeping";

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 620,
        margin: "0 auto",
        padding: 20,
        background: "var(--ctp-mantle, #11111b)",
        border: "1px solid var(--border-subtle, #313244)",
        borderRadius: 14,
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        color: "var(--ctp-text, #cdd6f4)",
      }}
    >
      <style>{`
        @keyframes kairosPulse {
          0%,100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(126,231,135,0.5); }
          50% { transform: scale(1.25); opacity: 0.85; box-shadow: 0 0 0 8px rgba(126,231,135,0); }
        }
        @keyframes kairosFadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
      `}</style>

      {/* Header: pulsing core + status */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: running ? "#7ee787" : active ? "#f0883e" : "#6e7681",
            animation: running
              ? "kairosPulse 1.6s ease-in-out infinite"
              : "none",
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1 }}>
          <div
            style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em" }}
          >
            KAIROS{" "}
            {running
              ? "— SELF-IMPROVING"
              : active
                ? "— " + status.toUpperCase()
                : "— IDLE"}
          </div>
          <div style={{ fontSize: 11, color: "var(--ctp-overlay0, #6c7086)" }}>
            {running
              ? "perceiving weaknesses → fixing → verifying → committing (isolated branch)"
              : live.sleepReason
                ? `sleeping — ${live.sleepReason}`
                : "the always-on operator"}
          </div>
        </div>
      </div>

      {/* Live counters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <Stat label="TICKS" value={String(tickCount)} />
        <Stat label="SPENT" value={`$${totalCost.toFixed(4)}`} />
        <Stat label="WAKE" value={live.lastWakeTrigger ?? "—"} />
      </div>

      {/* Live activity feed */}
      <div
        style={{
          maxHeight: 190,
          overflowY: "auto",
          borderTop: "1px solid var(--border-subtle, #313244)",
          paddingTop: 10,
        }}
      >
        {feed.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: "var(--ctp-overlay0, #6c7086)",
              padding: "8px 0",
            }}
          >
            Waiting for the next tick…{" "}
            {running ? "" : "(KAIROS is not running)"}
          </div>
        ) : (
          feed.map((e) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "baseline",
                fontSize: 12,
                padding: "3px 0",
                animation: "kairosFadeIn 0.25s ease",
              }}
            >
              <span
                style={{
                  color: KIND_COLOR[e.kind] ?? "#8b949e",
                  width: 14,
                  flexShrink: 0,
                }}
              >
                {KIND_GLYPH[e.kind] ?? "·"}
              </span>
              <span
                style={{
                  color: "var(--ctp-overlay0, #6c7086)",
                  width: 62,
                  flexShrink: 0,
                }}
              >
                {new Date(e.at).toLocaleTimeString([], { hour12: false })}
              </span>
              <span style={{ color: "var(--ctp-subtext1, #bac2de)" }}>
                {e.label}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        flex: 1,
        padding: "8px 12px",
        background: "var(--ctp-base, #1e1e2e)",
        border: "1px solid var(--border-subtle, #313244)",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: "0.12em",
          color: "var(--ctp-overlay0, #6c7086)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: "var(--ctp-text, #cdd6f4)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
