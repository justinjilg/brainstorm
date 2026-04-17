/**
 * Dashboard View — rebuilt with the BR component layer.
 *
 * Always-on stats-row at the top, three tabs below (Tools / Routing /
 * Cost). All content lives inside DashCards so the view is visually
 * identical to the @brainst0rm/router dashboard. Previously this view
 * had hardcoded $0.0000 placeholders and a stub "Routing decisions will
 * appear here…" block — both of those are now backed by real data:
 *   · Cost → cost.summary IPC aggregation (today / month / by model).
 *   · Routing → decisions captured from chat events in App.tsx.
 *   · Tools → tools.list IPC, grouped by category (unchanged).
 */

import { useMemo, useState } from "react";
import {
  useTools,
  useHealthStats,
  useCostSummary,
} from "../../hooks/useServerData";
import {
  DashCard,
  EmptyState,
  PageHeader,
  SkeletonRows,
  SkeletonStatsRow,
  StatCard,
  StatsRow,
} from "../br";

export type DashboardTab = "tools" | "routing" | "cost";

export interface RoutingDecision {
  id: string;
  timestamp: number;
  modelName?: string;
  provider?: string;
  strategy?: string;
  reason?: string;
  cost?: number;
}

interface DashboardProps {
  sessionCost: number;
  routingDecisions: RoutingDecision[];
}

export function DashboardView({
  sessionCost,
  routingDecisions,
}: DashboardProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>("tools");
  const tools = useTools();
  const health = useHealthStats();
  const cost = useCostSummary();

  const toolCountText = String(tools.count);
  const todayText = cost.summary ? formatUsd(cost.summary.today) : "—";
  const monthText = cost.summary ? formatUsd(cost.summary.month) : "—";
  const uptime = health ? formatUptime(health.uptime_seconds) : "—";
  const godModeCount = `${health?.god_mode?.connected ?? 0}`;

  return (
    <div
      className="flex-1 overflow-y-auto mode-crossfade"
      data-testid="dashboard-view"
      style={{ background: "var(--ink-1)" }}
    >
      <div
        className="mx-auto"
        style={{
          maxWidth: 1200,
          padding: "var(--space-8) var(--space-10) var(--space-16)",
        }}
      >
        <PageHeader
          title="Dashboard"
          description="Operator-console view of the Brainstorm runtime — session cost, tools, routing, and historical spend at a glance."
          tabs={[
            { id: "tools", label: "Tools", testId: "dashboard-tab-tools" },
            {
              id: "routing",
              label: "Routing",
              testId: "dashboard-tab-routing",
            },
            { id: "cost", label: "Cost", testId: "dashboard-tab-cost" },
          ]}
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as DashboardTab)}
        />

        {/* Always-on stats row — session + today + month + tools + systems + uptime. */}
        {cost.loading && !cost.summary ? (
          <SkeletonStatsRow count={6} />
        ) : (
          <StatsRow>
            <StatCard
              label="Session"
              value={formatUsd(sessionCost)}
              accent="accent"
              tooltip="Cost of the current conversation since the app started"
            />
            <StatCard
              label="Today"
              value={todayText}
              accent="warning"
              tooltip="Sum of all cost_records since local midnight"
            />
            <StatCard
              label="This Month"
              value={monthText}
              accent="warning"
              tooltip="Month-to-date cost across every session"
            />
            <StatCard
              label="Tools"
              value={toolCountText}
              accent="info"
              testId="tool-count"
              tooltip="Built-in tools available to the agent loop"
            />
            <StatCard
              label="Systems"
              value={godModeCount}
              accent="success"
              tooltip="God Mode connectors currently online"
            />
            <StatCard
              label="Uptime"
              value={uptime}
              accent="accent"
              tooltip="How long the backend child process has been running"
            />
          </StatsRow>
        )}

        <div className="home-stack" data-testid="dashboard-content">
          {activeTab === "tools" && (
            <ToolsPanel
              grouped={tools.grouped}
              loading={tools.loading}
              error={tools.error}
            />
          )}
          {activeTab === "routing" && (
            <RoutingPanel decisions={routingDecisions} />
          )}
          {activeTab === "cost" && (
            <CostPanel
              sessionCost={sessionCost}
              summary={cost.summary}
              loading={cost.loading}
              error={cost.error}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Tools panel ──────────────────────────────────────────────────────

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
      <DashCard eyebrow="REGISTRY" title="Tools">
        <div
          data-testid="tools-error"
          style={{ fontSize: "var(--text-sm)", color: "var(--sig-err)" }}
        >
          {error}
        </div>
      </DashCard>
    );
  }

  if (loading) {
    return (
      <DashCard eyebrow="REGISTRY" title="Tools">
        <SkeletonRows count={4} />
      </DashCard>
    );
  }

  const total = grouped.reduce((s, g) => s + g.count, 0);

  return (
    <DashCard eyebrow="REGISTRY" title={`Tools (${total})`}>
      {grouped.length === 0 ? (
        <EmptyState
          icon={<EmptyToolsMark />}
          heading="No tools registered"
          description="The backend started with an empty tool registry. Enable built-in tools or wire an MCP server to see them here."
        />
      ) : (
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          }}
        >
          {grouped.map((group) => (
            <button
              key={group.category}
              type="button"
              onClick={() =>
                setExpandedCat(
                  expandedCat === group.category ? null : group.category,
                )
              }
              data-testid={`tool-category-${group.category}`}
              className="br-btn text-left"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                padding: "var(--space-4)",
                gap: "var(--space-1)",
                background:
                  expandedCat === group.category
                    ? "var(--ink-3)"
                    : "var(--ink-2)",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-md)",
                  fontWeight: 500,
                  color: "var(--bone)",
                }}
              >
                {group.category}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-2xs)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--bone-mute)",
                }}
              >
                {group.count} tools
              </span>
            </button>
          ))}
        </div>
      )}

      {expandedCat && (
        <div
          className="animate-fade-in"
          style={{ marginTop: "var(--space-4)" }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--bone-mute)",
              marginBottom: 8,
            }}
          >
            {expandedCat}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th style={{ width: 100 }}>Permission</th>
              </tr>
            </thead>
            <tbody>
              {grouped
                .find((g) => g.category === expandedCat)
                ?.tools.map((tool) => (
                  <tr key={tool.name}>
                    <td className="font-mono" style={{ color: "var(--bone)" }}>
                      {tool.name}
                    </td>
                    <td>{tool.description}</td>
                    <td>
                      <span
                        className="font-mono"
                        style={{
                          fontSize: "var(--text-2xs)",
                          color: permissionColor(tool.permission),
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                        }}
                      >
                        {tool.permission}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </DashCard>
  );
}

// ── Routing panel ────────────────────────────────────────────────────

function RoutingPanel({ decisions }: { decisions: RoutingDecision[] }) {
  if (decisions.length === 0) {
    return (
      <DashCard eyebrow="INTELLIGENCE" title="Routing decisions">
        <EmptyState
          icon={<EmptyRoutingMark />}
          heading="No routing decisions yet"
          description="Each chat turn picks a model via the router; decisions appear here in real time as they happen."
        />
      </DashCard>
    );
  }

  // Recent-first; cap at 50 rows so the table doesn't balloon.
  const ordered = [...decisions].reverse().slice(0, 50);

  return (
    <DashCard
      eyebrow="INTELLIGENCE"
      title={`Routing decisions (${decisions.length})`}
    >
      <table className="data-table" data-testid="routing-table">
        <thead>
          <tr>
            <th style={{ width: 90 }}>Time</th>
            <th>Model</th>
            <th>Strategy</th>
            <th>Reason</th>
            <th className="num" style={{ width: 100 }}>
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((d) => (
            <tr key={d.id}>
              <td className="font-mono" style={{ color: "var(--bone-mute)" }}>
                {formatTime(d.timestamp)}
              </td>
              <td style={{ color: "var(--bone)" }}>
                {d.modelName ?? "—"}
                {d.provider ? (
                  <span
                    className="font-mono"
                    style={{
                      marginLeft: 8,
                      fontSize: "var(--text-2xs)",
                      color: "var(--bone-mute)",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    {d.provider}
                  </span>
                ) : null}
              </td>
              <td className="font-mono" style={{ color: "var(--bone-dim)" }}>
                {d.strategy ?? "—"}
              </td>
              <td style={{ color: "var(--bone-dim)" }}>{d.reason ?? "—"}</td>
              <td className="num">
                {d.cost != null ? formatUsd(d.cost) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </DashCard>
  );
}

// ── Cost panel ───────────────────────────────────────────────────────

function CostPanel({
  sessionCost,
  summary,
  loading,
  error,
}: {
  sessionCost: number;
  summary: ReturnType<typeof useCostSummary>["summary"];
  loading: boolean;
  error: string | null;
}) {
  const rows = useMemo(
    () =>
      summary
        ? [...summary.byModel].sort((a, b) => b.totalCost - a.totalCost)
        : [],
    [summary],
  );

  return (
    <>
      <DashCard eyebrow="LEDGER" title="Totals">
        {error ? (
          <div
            data-testid="cost-error"
            style={{ fontSize: "var(--text-sm)", color: "var(--sig-err)" }}
          >
            {error}
          </div>
        ) : loading && !summary ? (
          <SkeletonRows count={3} />
        ) : (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            }}
          >
            <CostTile label="Session" value={sessionCost} />
            <CostTile label="Today" value={summary?.today ?? 0} />
            <CostTile label="This Month" value={summary?.month ?? 0} />
          </div>
        )}
      </DashCard>

      <DashCard eyebrow="BREAKDOWN" title="Top models">
        {loading && !summary ? (
          <SkeletonRows count={5} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<EmptyCostMark />}
            heading="No spend recorded yet"
            description="Chat turns, workflow runs, and daemon ticks all write to cost_records. As soon as one happens you'll see a model-level breakdown here."
          />
        ) : (
          <table className="data-table" data-testid="cost-by-model">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num" style={{ width: 140 }}>
                  Requests
                </th>
                <th className="num" style={{ width: 140 }}>
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.modelId}>
                  <td className="font-mono" style={{ color: "var(--bone)" }}>
                    {r.modelId}
                  </td>
                  <td className="num">{r.requestCount}</td>
                  <td className="num">{formatUsd(r.totalCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DashCard>
    </>
  );
}

function CostTile({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: "var(--space-4) var(--space-5)",
        border: "1px solid var(--ink-line)",
        borderRadius: "var(--radius)",
        background: "var(--ink-1)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-2xs)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--bone-mute)",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        className="tabular-nums"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "var(--text-xl)",
          fontWeight: 500,
          color: "var(--bone)",
          letterSpacing: "-0.02em",
        }}
      >
        {formatUsd(value)}
      </div>
    </div>
  );
}

// ── Empty-state marks ────────────────────────────────────────────────

function EmptyToolsMark() {
  // Four nested squares — a plan/tool chest silhouette.
  return (
    <svg viewBox="0 0 88 88" fill="none" aria-hidden>
      <rect
        x="10"
        y="18"
        width="68"
        height="56"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="20"
        y="26"
        width="20"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <rect
        x="46"
        y="26"
        width="24"
        height="8"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <rect
        x="46"
        y="38"
        width="24"
        height="4"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <rect
        x="20"
        y="48"
        width="50"
        height="18"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      <circle cx="26" cy="18" r="2" fill="currentColor" />
      <circle cx="44" cy="18" r="2" fill="currentColor" />
      <circle cx="62" cy="18" r="2" fill="currentColor" />
    </svg>
  );
}

function EmptyRoutingMark() {
  // Three paths fanning from a central node — router decision tree.
  return (
    <svg viewBox="0 0 88 88" fill="none" aria-hidden>
      <circle cx="20" cy="44" r="4" fill="currentColor" />
      <circle cx="68" cy="22" r="3.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="68" cy="44" r="3.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="68" cy="66" r="3.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M24 44 Q46 22 64 22"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="none"
      />
      <path
        d="M24 44 L64 44"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="none"
      />
      <path
        d="M24 44 Q46 66 64 66"
        stroke="currentColor"
        strokeWidth="1.1"
        fill="none"
      />
    </svg>
  );
}

function EmptyCostMark() {
  // A ledger line — horizontal rule with four stacked bars above.
  return (
    <svg viewBox="0 0 88 88" fill="none" aria-hidden>
      <rect
        x="14"
        y="54"
        width="6"
        height="16"
        fill="currentColor"
        fillOpacity="0.4"
      />
      <rect
        x="26"
        y="42"
        width="6"
        height="28"
        fill="currentColor"
        fillOpacity="0.55"
      />
      <rect
        x="38"
        y="48"
        width="6"
        height="22"
        fill="currentColor"
        fillOpacity="0.7"
      />
      <rect
        x="50"
        y="34"
        width="6"
        height="36"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <rect x="62" y="22" width="6" height="48" fill="currentColor" />
      <line
        x1="8"
        y1="74"
        x2="80"
        y2="74"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

// ── Format helpers ───────────────────────────────────────────────────

function formatUsd(n: number): string {
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function permissionColor(permission: string): string {
  if (permission === "auto") return "var(--sig-ok)";
  if (permission === "confirm") return "var(--sig-warn)";
  return "var(--sig-err)";
}
