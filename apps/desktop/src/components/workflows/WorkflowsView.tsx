/**
 * Workflows View — plan trees, orchestration visualization.
 */

import { useState, useEffect } from "react";
import { request } from "../../lib/ipc-client";

interface WorkflowPreset {
  id: string;
  name: string;
  description: string;
  steps: number;
}

export function WorkflowsView() {
  const [showHint, setShowHint] = useState(false);
  const [presets, setPresets] = useState<WorkflowPreset[]>([]);

  useEffect(() => {
    request<WorkflowPreset[]>("workflow.presets")
      .then(setPresets)
      .catch(() => {});
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--ctp-surface0)]">
        <span className="text-xs font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider">
          Workflows
        </span>
        <button
          onClick={() => setShowHint(true)}
          data-testid="new-workflow"
          className="interactive text-[10px] px-3 py-1 rounded-lg bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)] hover:text-[var(--ctp-text)]"
        >
          + New Workflow
        </button>
      </div>

      {showHint && (
        <div
          data-testid="workflow-hint"
          className="mx-4 mt-3 px-4 py-3 rounded-xl animate-fade-in flex items-center justify-between"
          style={{
            background: "var(--glow-mauve)",
            border: "1px solid rgba(203, 166, 247, 0.2)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-mauve)",
          }}
        >
          <span>
            Workflows are coming soon. Define multi-phase execution plans in the
            Plan view.
          </span>
          <button
            onClick={() => setShowHint(false)}
            data-testid="dismiss-hint"
            className="interactive px-2 py-0.5 rounded-md ml-3 shrink-0"
            style={{ fontSize: "var(--text-2xs)" }}
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Preset workflows from backend */}
        {presets.length > 0 && (
          <div>
            <div
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Preset Workflows ({presets.length})
            </div>
            <div className="grid grid-cols-2 gap-2">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="interactive px-4 py-3 rounded-xl"
                  style={{
                    background: "var(--ctp-surface0)",
                    border: "1px solid var(--border-subtle)",
                  }}
                >
                  <div
                    className="font-medium mb-1"
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--ctp-text)",
                    }}
                  >
                    {preset.name}
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ctp-overlay0)",
                    }}
                  >
                    {preset.description || `${preset.steps} steps`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Execution history */}
        <div
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay0)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Execution History
        </div>
        <div className="space-y-2">
          <PlanNode
            level={0}
            icon="▼"
            label="Phase 1: Foundation"
            status="complete"
            meta="5/5 tasks"
          >
            <PlanNode
              level={1}
              icon="▼"
              label="Sprint 1: Scaffold"
              status="complete"
              meta="2/2"
            >
              <PlanNode
                level={2}
                icon="✓"
                label="Tauri 2 scaffold"
                status="complete"
                meta="$0.00 · Claude Opus 4.6"
              />
              <PlanNode
                level={2}
                icon="✓"
                label="Three-panel layout"
                status="complete"
                meta="$0.00 · Claude Opus 4.6"
              />
            </PlanNode>
            <PlanNode
              level={1}
              icon="▼"
              label="Sprint 2: Streaming"
              status="complete"
              meta="3/3"
            >
              <PlanNode
                level={2}
                icon="✓"
                label="API client"
                status="complete"
                meta="$0.00"
              />
              <PlanNode
                level={2}
                icon="✓"
                label="SSE hooks"
                status="complete"
                meta="$0.00"
              />
              <PlanNode
                level={2}
                icon="✓"
                label="Chat view"
                status="complete"
                meta="$0.00"
              />
            </PlanNode>
          </PlanNode>

          <PlanNode
            level={0}
            icon="▼"
            label="Phase 2: Intelligence"
            status="in-progress"
            meta="3/5 tasks"
          >
            <PlanNode
              level={1}
              icon="◐"
              label="Dashboard"
              status="in-progress"
              meta=""
            />
            <PlanNode
              level={1}
              icon="✓"
              label="Models view"
              status="complete"
              meta=""
            />
            <PlanNode
              level={1}
              icon="✓"
              label="Memory view"
              status="complete"
              meta=""
            />
            <PlanNode
              level={1}
              icon="○"
              label="Role system"
              status="pending"
              meta=""
            />
            <PlanNode
              level={1}
              icon="○"
              label="Approval cards"
              status="pending"
              meta=""
            />
          </PlanNode>

          <PlanNode
            level={0}
            icon="▶"
            label="Phase 3: White-Box Memory"
            status="pending"
            meta="0/5"
          />
          <PlanNode
            level={0}
            icon="▶"
            label="Phase 4: Multi-Agent"
            status="pending"
            meta="0/5"
          />
          <PlanNode
            level={0}
            icon="▶"
            label="Phase 5: Operations"
            status="pending"
            meta="0/4"
          />
          <PlanNode
            level={0}
            icon="▶"
            label="Phase 6: Polish"
            status="pending"
            meta="0/5"
          />
        </div>
      </div>
    </div>
  );
}

function PlanNode({
  level,
  icon,
  label,
  status,
  meta,
  children,
}: {
  level: number;
  icon: string;
  label: string;
  status: "complete" | "in-progress" | "pending";
  meta: string;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(children != null);
  const statusColor =
    status === "complete"
      ? "var(--ctp-green)"
      : status === "in-progress"
        ? "var(--ctp-yellow)"
        : "var(--ctp-overlay0)";

  return (
    <div style={{ marginLeft: level * 16 }}>
      <div
        onClick={() => children && setExpanded(!expanded)}
        className="interactive flex items-center gap-2 py-1 px-2 rounded"
      >
        <span className="text-xs" style={{ color: statusColor }}>
          {icon}
        </span>
        <span
          className={`text-sm ${
            status === "complete"
              ? "text-[var(--ctp-subtext0)]"
              : "text-[var(--ctp-text)]"
          }`}
        >
          {label}
        </span>
        {meta && (
          <span className="text-[10px] text-[var(--ctp-overlay0)]">{meta}</span>
        )}
      </div>
      {expanded && children}
    </div>
  );
}
