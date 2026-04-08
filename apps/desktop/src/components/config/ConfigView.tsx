/**
 * Config View — wired to real server health data.
 */

import { useHealthStats, useTools } from "../../hooks/useServerData";

export function ConfigView() {
  const health = useHealthStats();
  const { count: toolCount } = useTools();

  return (
    <div
      className="flex-1 overflow-y-auto bg-[var(--ctp-base)]"
      style={{ padding: 24 }}
    >
      <div className="max-w-[720px] mx-auto space-y-6">
        <Section title="Server">
          <Row
            label="Status"
            value={health?.status ?? "unknown"}
            badge
            badgeColor={
              health?.status === "healthy"
                ? "var(--ctp-green)"
                : "var(--ctp-red)"
            }
          />
          <Row label="Version" value={health?.version ?? "—"} />
          <Row
            label="Uptime"
            value={
              health
                ? `${Math.floor(health.uptime_seconds / 60)}m ${health.uptime_seconds % 60}s`
                : "—"
            }
          />
          <Row label="Tools" value={String(toolCount)} />
          <Row
            label="God Mode"
            value={`${health?.god_mode.connected ?? 0} systems, ${health?.god_mode.tools ?? 0} tools`}
          />
          <Row
            label="Conversations"
            value={String(health?.conversations.active ?? 0)}
          />
        </Section>

        <Section title="Routing Strategy">
          <Row label="Active strategy" value="combined" />
          <Row
            label="Routing mode"
            value="auto (Thompson sampling when data available)"
          />
          <Row label="Cost weight" value="0.25" />
        </Section>

        <Section title="Permissions">
          <Row
            label="Mode"
            value="confirm"
            badge
            badgeColor="var(--ctp-yellow)"
          />
          <Row label="Session TTL" value="30 minutes" />
        </Section>

        <Section title="KAIROS Daemon">
          <Row label="Status" value="stopped" />
          <Row label="Tick interval" value="30,000ms" />
          <Row label="Max ticks/session" value="100" />
          <Row label="Approval gate" value="every 25 ticks" />
        </Section>

        <Section title="Budget">
          <Row label="Session limit" value="$5.00" />
          <Row label="Daily limit" value="$50.00" />
          <Row label="Monthly limit" value="$500.00" />
          <Row
            label="Hard limit"
            value="enabled"
            badge
            badgeColor="var(--ctp-red)"
          />
        </Section>

        <Section title="Security">
          <Row
            label="Middleware layers"
            value="8 active"
            badge
            badgeColor="var(--ctp-green)"
          />
          <Row label="Trust propagation" value="enabled" />
          <Row label="Egress monitor" value="enabled" />
          <Row label="Approval velocity" value="3 rapid threshold" />
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mb-2"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      <div
        className="rounded-xl overflow-hidden"
        style={{
          background: "var(--ctp-surface0)",
          border: "1px solid var(--border-subtle)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  badge,
  badgeColor,
}: {
  label: string;
  value: string;
  badge?: boolean;
  badgeColor?: string;
}) {
  return (
    <div
      className="flex items-center justify-between px-4 py-2.5"
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: "var(--text-xs)",
      }}
    >
      <span style={{ color: "var(--ctp-overlay1)" }}>{label}</span>
      {badge ? (
        <span
          className="px-2 py-0.5 rounded-md"
          style={{
            fontSize: "var(--text-2xs)",
            color: badgeColor,
            background: `${badgeColor}15`,
          }}
        >
          {value}
        </span>
      ) : (
        <span style={{ color: "var(--ctp-text)" }}>{value}</span>
      )}
    </div>
  );
}
