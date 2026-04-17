/**
 * Inspector Panel — context-sensitive right panel.
 * Shows different content based on what's selected in the workspace.
 */

import type { TeamAgent } from "../navigator/TeamBuilder";
import type { TraceEvent } from "../trace/TraceView";

// The inspector no longer supports a "task" type — the Plan view was
// rewritten to drop its fake per-task UI, so there is no task entity to
// inspect anymore. When a real workflow-stream IPC lands and Plan grows
// per-step entities back, re-introduce `{ type: "task"; task: PlanTask }`
// here with a real shape (not the old decorative one).
export type InspectorContext =
  | { type: "none" }
  | { type: "agent"; agent: TeamAgent }
  | { type: "trace-event"; event: TraceEvent }
  | { type: "diff"; filePath: string; content: string }
  | { type: "cost"; sessionCost: number; budget: number };

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "var(--color-anthropic)",
  openai: "var(--color-openai)",
  google: "var(--color-google)",
  deepseek: "var(--color-deepseek)",
};

const ROLE_COLORS: Record<string, string> = {
  architect: "var(--ctp-mauve)",
  coder: "var(--ctp-green)",
  reviewer: "var(--ctp-yellow)",
  debugger: "var(--ctp-peach)",
  qa: "var(--ctp-red)",
  devops: "var(--ctp-sky)",
};

interface InspectorPanelProps {
  context: InspectorContext;
  onClose: () => void;
}

export function InspectorPanel({ context, onClose }: InspectorPanelProps) {
  return (
    <div
      data-testid="inspector-panel"
      className="flex flex-col overflow-hidden animate-slide-in-right"
      style={{
        width: 320,
        background: "var(--ctp-mantle)",
        borderLeft: "1px solid var(--border-subtle)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        <span
          data-testid="inspector-label"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay0)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          {context.type === "none" ? "Inspector" : contextLabel(context)}
        </span>
        <button
          onClick={onClose}
          data-testid="inspector-close"
          className="interactive px-2 py-1 rounded-md"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
        >
          ⌘D
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {context.type === "none" && <EmptyInspector />}
        {context.type === "agent" && <AgentInspector agent={context.agent} />}
        {context.type === "trace-event" && (
          <TraceEventInspector event={context.event} />
        )}
        {context.type === "diff" && (
          <DiffInspector
            filePath={context.filePath}
            content={context.content}
          />
        )}
        {context.type === "cost" && (
          <CostInspector
            sessionCost={context.sessionCost}
            budget={context.budget}
          />
        )}
      </div>
    </div>
  );
}

function contextLabel(ctx: InspectorContext): string {
  switch (ctx.type) {
    case "agent":
      return `Agent: ${ctx.agent.role}`;
    case "trace-event":
      return "Event Detail";
    case "diff":
      return "Diff";
    case "cost":
      return "Cost Breakdown";
    default:
      return "Inspector";
  }
}

function EmptyInspector() {
  return (
    <div
      className="flex items-center justify-center h-full text-center"
      style={{ fontSize: "var(--text-xs)", color: "var(--ctp-overlay0)" }}
    >
      <div>
        <div className="mb-2">Select an item to inspect</div>
        <div style={{ fontSize: "var(--text-2xs)" }}>
          Click agents, tasks, or events
        </div>
      </div>
    </div>
  );
}

function AgentInspector({ agent }: { agent: TeamAgent }) {
  const roleColor = ROLE_COLORS[agent.role] ?? "var(--ctp-overlay1)";
  const provColor = PROVIDER_COLORS[agent.provider] ?? "var(--ctp-overlay0)";

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Identity */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span
            className="w-3 h-3 rounded-full"
            style={{ background: roleColor }}
          />
          <span
            className="font-semibold"
            style={{ fontSize: "var(--text-lg)", color: roleColor }}
          >
            {agent.role}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: provColor }}
          />
          <span
            style={{ fontSize: "var(--text-xs)", color: "var(--ctp-subtext1)" }}
          >
            {agent.model}
          </span>
        </div>
      </div>

      {/* Budget */}
      <MetaSection title="Budget">
        <div className="flex items-center justify-between">
          <span
            style={{ fontSize: "var(--text-xs)", color: "var(--ctp-overlay1)" }}
          >
            Allocated
          </span>
          <span
            className="font-mono"
            style={{ fontSize: "var(--text-sm)", color: "var(--ctp-text)" }}
          >
            ${agent.budget.toFixed(2)}
          </span>
        </div>
      </MetaSection>

      {/* Skills */}
      <MetaSection title="Skills">
        <div className="space-y-1">
          {agent.skills.map((skill) => (
            <div
              key={skill}
              className="px-3 py-1.5 rounded-lg"
              style={{
                background: "var(--ctp-surface0)",
                border: "1px solid var(--border-subtle)",
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-subtext1)",
              }}
            >
              {skill}
            </div>
          ))}
        </div>
      </MetaSection>
    </div>
  );
}

// TaskInspector removed alongside Plan view's fake phase/task UI.
// Will return when a real workflow-stream IPC exposes per-step task
// entities with honest data (cost, duration, output, worktree).

function TraceEventInspector({ event }: { event: TraceEvent }) {
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <span
          style={{
            color: ROLE_COLORS[event.agentRole] ?? "var(--ctp-overlay1)",
            fontSize: "var(--text-sm)",
          }}
        >
          {event.agentRole}
        </span>
        <span
          className="font-mono"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
        >
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {event.toolName && (
        <MetaSection title="Tool">
          <div
            className="font-mono"
            style={{ fontSize: "var(--text-xs)", color: "var(--ctp-mauve)" }}
          >
            {event.toolName}
          </div>
          {event.toolDurationMs != null && (
            <div
              className="font-mono"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              {event.toolDurationMs}ms
            </div>
          )}
        </MetaSection>
      )}

      {event.toolArgs && (
        <MetaSection title="Input">
          <pre
            className="whitespace-pre-wrap"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay1)",
              background: "var(--ctp-crust)",
              padding: 8,
              borderRadius: 8,
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {event.toolArgs}
          </pre>
        </MetaSection>
      )}

      {event.toolOutput && (
        <MetaSection title="Output">
          <pre
            className="whitespace-pre-wrap"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay1)",
              background: "var(--ctp-crust)",
              padding: 8,
              borderRadius: 8,
              maxHeight: 300,
              overflow: "auto",
            }}
          >
            {event.toolOutput}
          </pre>
        </MetaSection>
      )}

      {event.cost != null && (
        <StatBox label="Cost" value={`$${event.cost.toFixed(4)}`} />
      )}
    </div>
  );
}

function DiffInspector({
  filePath,
  content,
}: {
  filePath: string;
  content: string;
}) {
  return (
    <div className="space-y-3 animate-fade-in">
      <div
        className="font-mono"
        style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
      >
        {filePath}
      </div>
      <pre
        className="whitespace-pre-wrap"
        style={{
          fontSize: "var(--text-2xs)",
          lineHeight: "1.5",
          background: "var(--ctp-crust)",
          padding: 12,
          borderRadius: 12,
          maxHeight: 500,
          overflow: "auto",
        }}
      >
        {content.split("\n").map((line, i) => {
          let color = "var(--ctp-text)";
          if (line.startsWith("+") && !line.startsWith("+++"))
            color = "var(--ctp-green)";
          else if (line.startsWith("-") && !line.startsWith("---"))
            color = "var(--ctp-red)";
          else if (line.startsWith("@@")) color = "var(--ctp-blue)";
          return (
            <div key={i} style={{ color }}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function CostInspector({
  sessionCost,
  budget,
}: {
  sessionCost: number;
  budget: number;
}) {
  const pct = budget > 0 ? (sessionCost / budget) * 100 : 0;
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="grid grid-cols-2 gap-3">
        <StatBox label="Session" value={`$${sessionCost.toFixed(4)}`} />
        <StatBox label="Budget" value={`$${budget.toFixed(2)}`} />
      </div>
      <div>
        <div
          className="flex justify-between mb-1"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
        >
          <span>Usage</span>
          <span>{pct.toFixed(0)}%</span>
        </div>
        <div
          className="rounded-full overflow-hidden"
          style={{ height: 6, background: "var(--ctp-surface0)" }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.min(100, pct)}%`,
              background:
                pct > 85
                  ? "var(--ctp-red)"
                  : pct > 60
                    ? "var(--ctp-yellow)"
                    : "var(--ctp-green)",
              transition: "width var(--duration-normal) var(--ease-out)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function MetaSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mb-1.5"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="p-3 rounded-xl"
      style={{
        background: "var(--ctp-surface0)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        className="font-mono font-medium"
        style={{ fontSize: "var(--text-sm)", color: "var(--ctp-text)" }}
      >
        {value}
      </div>
    </div>
  );
}
