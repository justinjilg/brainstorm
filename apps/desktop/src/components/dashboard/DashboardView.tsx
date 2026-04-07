/**
 * Dashboard View — cost, routing, tool health, KAIROS ↔ BR intelligence.
 */

import { useState } from "react";

interface DashboardProps {
  sessionCost: number;
  contextPercent: number;
}

export function DashboardView({ sessionCost }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<"routing" | "tools" | "cost">(
    "routing",
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top metrics bar */}
      <div className="flex items-center gap-6 px-4 py-2 border-b border-[var(--ctp-surface0)] text-xs bg-[var(--ctp-mantle)]">
        <Metric label="Session" value={`$${sessionCost.toFixed(4)}`} />
        <Metric label="Turns" value="0" />
        <Metric label="Tools" value="53" />
        <Metric label="Models" value="0L / 0C" />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-2 border-b border-[var(--ctp-surface0)]">
        {(["routing", "tools", "cost"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 text-xs rounded-t-lg transition-colors ${
              activeTab === tab
                ? "bg-[var(--ctp-surface0)] text-[var(--ctp-text)]"
                : "text-[var(--ctp-overlay0)] hover:text-[var(--ctp-subtext0)]"
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "routing" && <RoutingPanel />}
        {activeTab === "tools" && <ToolsPanel />}
        {activeTab === "cost" && <CostPanel sessionCost={sessionCost} />}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[var(--ctp-overlay0)]">{label}</span>
      <span className="text-[var(--ctp-text)] font-medium">{value}</span>
    </div>
  );
}

function RoutingPanel() {
  return (
    <div className="space-y-4">
      <SectionHeader title="Routing Log" />
      <div className="text-sm text-[var(--ctp-overlay1)]">
        Routing decisions will appear here when the agent processes messages.
        Each entry shows: model selected, strategy used, reason, and cost.
      </div>

      <SectionHeader title="Model Momentum" />
      <div className="p-3 rounded-lg bg-[var(--ctp-surface0)] text-sm">
        <div className="flex items-center gap-2 text-[var(--ctp-overlay1)]">
          <span className="w-2 h-2 rounded-full bg-[var(--ctp-overlay0)]" />
          No momentum — send a message to start routing
        </div>
      </div>

      <SectionHeader title="Thompson Sampling" />
      <div className="text-sm text-[var(--ctp-overlay1)]">
        Convergence alerts and model distribution will appear after the learned
        strategy accumulates enough data points.
      </div>
    </div>
  );
}

function ToolsPanel() {
  const categories = [
    { name: "GitHub", count: 8, icon: "🔗" },
    { name: "Git", count: 6, icon: "📝" },
    { name: "File", count: 8, icon: "📁" },
    { name: "Shell", count: 3, icon: "⌨" },
    { name: "Web", count: 2, icon: "🌐" },
    { name: "Memory", count: 1, icon: "💾" },
    { name: "Tasks", count: 3, icon: "✓" },
    { name: "BR Intelligence", count: 8, icon: "🧠" },
    { name: "Other", count: 14, icon: "⚙" },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader title="Tool Registry (53)" />
      <div className="grid grid-cols-3 gap-2">
        {categories.map((cat) => (
          <div
            key={cat.name}
            className="p-3 rounded-lg bg-[var(--ctp-surface0)] hover:bg-[var(--ctp-surface1)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 mb-1">
              <span>{cat.icon}</span>
              <span className="text-xs font-medium text-[var(--ctp-text)]">
                {cat.name}
              </span>
            </div>
            <div className="text-[10px] text-[var(--ctp-overlay0)]">
              {cat.count} tools
            </div>
          </div>
        ))}
      </div>

      <SectionHeader title="Tool Health" />
      <div className="text-sm text-[var(--ctp-overlay1)]">
        Tool success rates and latency will appear after tool executions.
      </div>
    </div>
  );
}

function CostPanel({ sessionCost }: { sessionCost: number }) {
  return (
    <div className="space-y-4">
      <SectionHeader title="Cost Tracking" />
      <div className="grid grid-cols-3 gap-3">
        <CostCard label="Session" value={sessionCost} />
        <CostCard label="Today" value={0} />
        <CostCard label="This Month" value={0} />
      </div>

      <SectionHeader title="Per-Model Breakdown" />
      <div className="text-sm text-[var(--ctp-overlay1)]">
        Cost breakdown by model will appear after messages are processed.
      </div>

      <SectionHeader title="Forecast" />
      <div className="p-3 rounded-lg bg-[var(--ctp-surface0)]">
        <div className="text-sm text-[var(--ctp-overlay1)]">
          Cost forecasting available after 5+ turns.
        </div>
      </div>
    </div>
  );
}

function CostCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-3 rounded-lg bg-[var(--ctp-surface0)]">
      <div className="text-[10px] text-[var(--ctp-overlay0)] mb-1">{label}</div>
      <div className="text-lg font-medium text-[var(--ctp-text)]">
        ${value.toFixed(4)}
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="text-xs font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider">
      {title}
    </div>
  );
}
