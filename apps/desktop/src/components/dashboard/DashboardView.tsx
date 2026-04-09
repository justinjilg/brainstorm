/**
 * Dashboard View — wired to real server data.
 */

import { useState } from "react";
import { useTools, useHealthStats } from "../../hooks/useServerData";

interface DashboardProps {
  sessionCost: number;
}

export function DashboardView({ sessionCost }: DashboardProps) {
  // contextPercent removed — only used in StatusRail
  const [activeTab, setActiveTab] = useState<"routing" | "tools" | "cost">(
    "tools",
  );
  const {
    grouped,
    count: toolCount,
    loading: toolsLoading,
    error: toolsError,
  } = useTools();
  const health = useHealthStats();

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--ctp-base)]">
      {/* Top metrics */}
      <div
        className="flex items-center gap-8 px-6 py-3 shrink-0"
        style={{
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--ctp-mantle)",
          fontSize: "var(--text-xs)",
        }}
      >
        <Metric label="Session" value={`$${sessionCost.toFixed(4)}`} />
        <Metric label="Tools" value={String(toolCount)} />
        <Metric
          label="God Mode"
          value={`${health?.god_mode?.connected ?? 0} systems`}
        />
        <Metric
          label="Server"
          value={health?.status ?? "unknown"}
          color={
            health?.status === "healthy" ? "var(--ctp-green)" : "var(--ctp-red)"
          }
        />
        <Metric
          label="Uptime"
          value={health ? formatUptime(health.uptime_seconds) : "—"}
        />
        <Metric label="Version" value={health?.version ?? "—"} />
      </div>

      {/* Tabs */}
      <div
        className="flex gap-1 px-6 pt-3"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        {(["tools", "routing", "cost"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            data-testid={`dashboard-tab-${tab}`}
            className="interactive px-4 py-2 rounded-t-lg"
            style={{
              fontSize: "var(--text-xs)",
              color:
                activeTab === tab ? "var(--ctp-text)" : "var(--ctp-overlay0)",
              background:
                activeTab === tab ? "var(--ctp-surface0)" : "transparent",
              borderBottom:
                activeTab === tab
                  ? "2px solid var(--ctp-mauve)"
                  : "2px solid transparent",
            }}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === "tools" && (
          <ToolsPanel
            grouped={grouped}
            loading={toolsLoading}
            error={toolsError}
          />
        )}
        {activeTab === "routing" && <RoutingPanel />}
        {activeTab === "cost" && <CostPanel sessionCost={sessionCost} />}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span style={{ color: "var(--ctp-overlay0)" }}>{label}</span>
      <span
        className="font-medium"
        style={{ color: color ?? "var(--ctp-text)" }}
      >
        {value}
      </span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function ToolsPanel({
  grouped,
  loading,
  error,
}: {
  grouped: Array<{
    category: string;
    tools: Array<{ name: string; description: string; permission: string }>;
    count: number;
  }>;
  loading: boolean;
  error: string | null;
}) {
  const [expandedCat, setExpandedCat] = useState<string | null>(null);

  if (error) {
    return (
      <div
        data-testid="tools-error"
        style={{ fontSize: "var(--text-sm)", color: "var(--ctp-red)" }}
      >
        {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="animate-pulse-glow"
        style={{ fontSize: "var(--text-sm)", color: "var(--ctp-overlay1)" }}
      >
        Loading tools...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        <span data-testid="tool-count">
          Tool Registry ({grouped.reduce((s, g) => s + g.count, 0)})
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {grouped.map((group) => (
          <button
            key={group.category}
            onClick={() =>
              setExpandedCat(
                expandedCat === group.category ? null : group.category,
              )
            }
            data-testid={`tool-category-${group.category}`}
            className="interactive text-left p-4 rounded-xl"
            style={{
              background:
                expandedCat === group.category
                  ? "var(--ctp-surface0)"
                  : "transparent",
              border: "1px solid var(--border-default)",
            }}
          >
            <div
              className="font-medium text-[var(--ctp-text)] mb-1"
              style={{ fontSize: "var(--text-sm)" }}
            >
              {group.category}
            </div>
            <div
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              {group.count} tools
            </div>
          </button>
        ))}
      </div>

      {/* Expanded tool list */}
      {expandedCat && (
        <div className="animate-fade-in space-y-1 mt-2">
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            {expandedCat}
          </div>
          {grouped
            .find((g) => g.category === expandedCat)
            ?.tools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-start gap-3 px-3 py-2 rounded-lg"
                style={{
                  background: "var(--ctp-surface0)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <span
                  className="font-mono shrink-0"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ctp-mauve)",
                  }}
                >
                  {tool.name}
                </span>
                <span
                  className="flex-1"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ctp-overlay1)",
                  }}
                >
                  {tool.description}
                </span>
                <span
                  className="shrink-0 px-1.5 py-0.5 rounded"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color:
                      tool.permission === "auto"
                        ? "var(--ctp-green)"
                        : tool.permission === "confirm"
                          ? "var(--ctp-yellow)"
                          : "var(--ctp-red)",
                    background:
                      tool.permission === "auto"
                        ? "var(--glow-green)"
                        : tool.permission === "confirm"
                          ? "rgba(249, 226, 175, 0.12)"
                          : "var(--glow-red)",
                  }}
                >
                  {tool.permission}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function RoutingPanel() {
  return (
    <div className="space-y-4">
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        Routing History
      </div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--ctp-overlay1)" }}>
        Routing decisions will appear here as messages are processed. Each entry
        shows model, strategy, reason, and cost.
      </div>
    </div>
  );
}

function CostPanel({ sessionCost }: { sessionCost: number }) {
  return (
    <div className="space-y-4">
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        Cost Tracking
      </div>
      <div className="grid grid-cols-3 gap-4">
        <CostCard label="Session" value={sessionCost} />
        <CostCard label="Today" value={0} />
        <CostCard label="This Month" value={0} />
      </div>
    </div>
  );
}

function CostCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      className="p-4 rounded-xl"
      style={{
        background: "var(--ctp-surface0)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        className="font-mono font-medium"
        style={{ fontSize: "var(--text-lg)", color: "var(--ctp-text)" }}
      >
        ${value.toFixed(4)}
      </div>
    </div>
  );
}
