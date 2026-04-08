/**
 * Trace View — real-time visibility into what agents are doing.
 * Shows every tool call, routing decision, and approval gate.
 */

import { useState, useRef, useEffect } from "react";

export interface TraceEvent {
  id: string;
  timestamp: number;
  agentRole: string;
  agentModel: string;
  provider: string;
  type:
    | "tool-call"
    | "tool-result"
    | "routing"
    | "text"
    | "approval-gate"
    | "error";
  toolName?: string;
  toolArgs?: string;
  toolOutput?: string;
  toolDurationMs?: number;
  toolSuccess?: boolean;
  text?: string;
  cost?: number;
  confidence?: number;
}

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

interface TraceViewProps {
  events: TraceEvent[];
  onEventSelect: (event: TraceEvent) => void;
  onApprove?: (eventId: string) => void;
  onDeny?: (eventId: string) => void;
}

export function TraceView({
  events,
  onEventSelect,
  onApprove,
  onDeny,
}: TraceViewProps) {
  const [filter, setFilter] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const filtered = filter
    ? events.filter(
        (e) =>
          e.agentRole === filter || e.type === filter || e.toolName === filter,
      )
    : events;

  // Get unique agents for filter
  const agents = [...new Set(events.map((e) => e.agentRole))];

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--ctp-base)]">
        <div className="text-center animate-fade-in">
          <div
            className="tracking-[0.2em] uppercase font-semibold mb-3"
            style={{ fontSize: "var(--text-lg)", color: "var(--ctp-overlay1)" }}
          >
            Agent Trace
          </div>
          <div
            style={{ fontSize: "var(--text-sm)", color: "var(--ctp-overlay0)" }}
          >
            Real-time visibility into agent tool calls, routing decisions, and
            approvals. Events appear here when a plan is executing.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--ctp-base)]">
      {/* Filter bar */}
      <div
        className="flex items-center gap-2 px-6 py-2 shrink-0"
        style={{
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--ctp-mantle)",
        }}
      >
        <button
          onClick={() => setFilter(null)}
          className="interactive px-2 py-1 rounded-md"
          style={{
            fontSize: "var(--text-2xs)",
            color: !filter ? "var(--ctp-text)" : "var(--ctp-overlay0)",
            background: !filter ? "var(--ctp-surface0)" : "transparent",
          }}
        >
          All ({events.length})
        </button>
        {agents.map((agent) => (
          <button
            key={agent}
            onClick={() => setFilter(filter === agent ? null : agent)}
            className="interactive px-2 py-1 rounded-md"
            style={{
              fontSize: "var(--text-2xs)",
              color:
                filter === agent
                  ? "var(--ctp-text)"
                  : (ROLE_COLORS[agent] ?? "var(--ctp-overlay0)"),
              background:
                filter === agent ? "var(--ctp-surface0)" : "transparent",
            }}
          >
            {agent}
          </button>
        ))}
      </div>

      {/* Event stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-[720px] mx-auto px-6 py-4 space-y-1">
          {filtered.map((event) => (
            <TraceEventRow
              key={event.id}
              event={event}
              onSelect={() => onEventSelect(event)}
              onApprove={onApprove}
              onDeny={onDeny}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TraceEventRow({
  event,
  onSelect,
  onApprove,
  onDeny,
}: {
  event: TraceEvent;
  onSelect: () => void;
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
}) {
  const time = new Date(event.timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const roleColor = ROLE_COLORS[event.agentRole] ?? "var(--ctp-overlay1)";
  const provColor = PROVIDER_COLORS[event.provider] ?? "var(--ctp-overlay0)";

  if (event.type === "approval-gate") {
    return (
      <div
        className="px-4 py-3 rounded-xl animate-fade-in"
        style={{
          background: "var(--glow-mauve)",
          border: "1px solid rgba(203, 166, 247, 0.2)",
        }}
      >
        <div
          className="flex items-center gap-2 mb-2"
          style={{ fontSize: "var(--text-xs)" }}
        >
          <span style={{ color: "var(--ctp-mauve)" }}>⚠</span>
          <span className="font-medium text-[var(--ctp-mauve)]">
            Approval Gate
          </span>
          <span className="font-mono text-[var(--ctp-overlay0)]">{time}</span>
        </div>
        <div
          style={{ fontSize: "var(--text-xs)", color: "var(--ctp-subtext1)" }}
          className="mb-2"
        >
          {event.text}
          {event.confidence != null && (
            <span
              className="ml-2 font-mono"
              style={{
                color:
                  event.confidence < 0.5
                    ? "var(--ctp-red)"
                    : "var(--ctp-yellow)",
              }}
            >
              confidence: {event.confidence.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onApprove?.(event.id)}
            className="interactive px-3 py-1.5 rounded-lg"
            style={{
              fontSize: "var(--text-2xs)",
              background: "var(--ctp-green)",
              color: "var(--ctp-crust)",
            }}
          >
            Approve
          </button>
          <button
            onClick={() => onDeny?.(event.id)}
            className="interactive px-3 py-1.5 rounded-lg"
            style={{
              fontSize: "var(--text-2xs)",
              border: "1px solid var(--border-default)",
              color: "var(--ctp-red)",
            }}
          >
            Deny
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={onSelect}
      className="interactive flex items-start gap-3 px-3 py-1.5 rounded-lg"
    >
      {/* Timestamp */}
      <span
        className="shrink-0 font-mono"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          width: 60,
        }}
      >
        {time}
      </span>

      {/* Agent */}
      <div className="shrink-0 flex items-center gap-1" style={{ width: 90 }}>
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: provColor }}
        />
        <span style={{ fontSize: "var(--text-2xs)", color: roleColor }}>
          {event.agentRole}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {event.type === "tool-call" && (
          <div className="flex items-center gap-2">
            <span
              className="font-mono"
              style={{ fontSize: "var(--text-xs)", color: "var(--ctp-text)" }}
            >
              {event.toolName}
            </span>
            {event.toolArgs && (
              <span
                className="truncate"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-overlay0)",
                }}
              >
                {event.toolArgs}
              </span>
            )}
          </div>
        )}
        {event.type === "tool-result" && (
          <div className="flex items-center gap-2">
            <span
              style={{
                color: event.toolSuccess
                  ? "var(--ctp-green)"
                  : "var(--ctp-red)",
                fontSize: "var(--text-xs)",
              }}
            >
              {event.toolSuccess ? "✓" : "✗"}
            </span>
            <span
              className="font-mono"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ctp-subtext1)",
              }}
            >
              {event.toolName}
            </span>
            {event.toolDurationMs != null && (
              <span
                className="font-mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ctp-overlay0)",
                }}
              >
                {event.toolDurationMs}ms
              </span>
            )}
          </div>
        )}
        {event.type === "routing" && (
          <span
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay1)",
            }}
          >
            → {event.text}
          </span>
        )}
        {event.type === "text" && (
          <span
            className="truncate"
            style={{ fontSize: "var(--text-xs)", color: "var(--ctp-subtext1)" }}
          >
            {event.text}
          </span>
        )}
        {event.type === "error" && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--ctp-red)" }}>
            ✗ {event.text}
          </span>
        )}
      </div>

      {/* Cost */}
      {event.cost != null && event.cost > 0 && (
        <span
          className="shrink-0 font-mono"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
        >
          ${event.cost.toFixed(4)}
        </span>
      )}
    </div>
  );
}
