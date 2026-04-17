/**
 * Config View — rebuilt on the BR component layer. Every section is a
 * DashCard with a mono eyebrow; every row is a labeled data line with
 * tabular-numeral values. Read-only — this is a reflection of loaded
 * config + live health, not an editor.
 */

import type { ReactNode } from "react";
import { useHealthStats, useTools, useConfig } from "../../hooks/useServerData";
import { DashCard, PageHeader } from "../br";

export function ConfigView() {
  const health = useHealthStats();
  const { count: toolCount } = useTools();
  const { config } = useConfig();

  return (
    <div
      className="flex-1 overflow-y-auto mode-crossfade"
      style={{
        background: "var(--ink-1)",
        padding: "var(--space-6) var(--space-8)",
      }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <PageHeader
          title="Configuration"
          description="Read-only reflection of the loaded brainstorm.toml + live server health. Edit via brainstorm.toml or the CLI."
        />

        <div className="home-stack">
          <DashCard eyebrow="SERVER" title="Runtime">
            <Row
              label="Status"
              value={health?.status ?? "unknown"}
              badge
              accent={health?.status === "healthy" ? "ok" : "err"}
            />
            <Row label="Version" value={health?.version ?? "—"} mono />
            <Row
              label="Uptime"
              value={
                health
                  ? `${Math.floor(health.uptime_seconds / 60)}m ${health.uptime_seconds % 60}s`
                  : "—"
              }
              mono
            />
            <Row label="Tools" value={String(toolCount)} mono />
            <Row
              label="God Mode"
              value={`${health?.god_mode?.connected ?? 0} systems · ${health?.god_mode?.tools ?? 0} tools`}
              mono
            />
            <Row
              label="Conversations"
              value={String(health?.conversations?.active ?? 0)}
              mono
            />
          </DashCard>

          <DashCard eyebrow="ROUTING" title="Strategy + defaults">
            <Row
              label="Active strategy"
              value={config?.general?.defaultModel ? "manual" : "combined"}
            />
            <Row
              label="Default model"
              value={config?.general?.defaultModel ?? "auto"}
              mono
            />
            <Row
              label="Output style"
              value={config?.general?.outputStyle ?? "default"}
              mono
            />
          </DashCard>

          <DashCard eyebrow="DAEMON" title="KAIROS">
            <Row
              label="Tick interval"
              value={`${config?.daemon?.tickIntervalMs ?? 30000}ms`}
              mono
            />
            <Row
              label="Max ticks/session"
              value={String(config?.daemon?.maxTicksPerSession ?? 100)}
              mono
            />
            <Row
              label="Approval gate"
              value={
                config?.daemon?.approvalGateInterval
                  ? `every ${config.daemon.approvalGateInterval} ticks`
                  : "disabled"
              }
            />
          </DashCard>

          <DashCard eyebrow="BUDGET" title="Spend limits">
            <Row
              label="Session limit"
              value={`$${config?.budget?.sessionLimit?.toFixed(2) ?? "5.00"}`}
              mono
            />
            <Row
              label="Daily limit"
              value={`$${config?.budget?.dailyLimit?.toFixed(2) ?? "50.00"}`}
              mono
            />
            <Row
              label="Monthly limit"
              value={`$${config?.budget?.monthlyLimit?.toFixed(2) ?? "500.00"}`}
              mono
            />
            <Row
              label="Hard limit"
              value={
                config?.budget?.hardLimit !== false ? "enabled" : "disabled"
              }
              badge
              accent={config?.budget?.hardLimit !== false ? "err" : "ok"}
            />
          </DashCard>

          <DashCard
            eyebrow="SECURITY"
            title="Middleware + policies"
            note="Pipeline catalog lives in the Security view. Live per-session status isn't introspected yet — needs a middleware.status IPC."
          />
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  badge,
  accent,
  mono,
}: {
  label: string;
  value: string;
  badge?: boolean;
  accent?: "ok" | "err" | "warn";
  mono?: boolean;
}) {
  const badgeColor =
    accent === "ok"
      ? "var(--sig-ok)"
      : accent === "err"
        ? "var(--sig-err)"
        : accent === "warn"
          ? "var(--sig-warn)"
          : "var(--bone)";
  const badgeBg =
    accent === "ok"
      ? "var(--sig-ok-haze)"
      : accent === "err"
        ? "var(--sig-err-haze)"
        : accent === "warn"
          ? "var(--sig-warn-haze)"
          : "var(--hi-haze)";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "var(--space-2) 0",
        borderBottom: "1px solid var(--ink-line)",
        fontSize: "var(--text-sm)",
      }}
    >
      <span
        className="font-mono"
        style={{
          color: "var(--bone-mute)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontSize: "var(--text-2xs)",
        }}
      >
        {label}
      </span>
      {badge ? (
        <Badge color={badgeColor} bg={badgeBg}>
          {value}
        </Badge>
      ) : (
        <span
          className={mono ? "font-mono tabular-nums" : undefined}
          style={{ color: "var(--bone)" }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function Badge({
  color,
  bg,
  children,
}: {
  color: string;
  bg: string;
  children: ReactNode;
}) {
  return (
    <span
      className="font-mono"
      style={{
        padding: "2px 8px",
        borderRadius: "var(--radius-xs)",
        fontSize: "var(--text-2xs)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color,
        background: bg,
        border: `1px solid ${color}`,
        borderColor: color.replace(")", "-glow)"),
      }}
    >
      {children}
    </span>
  );
}
