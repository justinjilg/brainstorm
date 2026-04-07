/**
 * Workflows View — plan trees, orchestration visualization.
 */

export function WorkflowsView() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--ctp-surface0)]">
        <span className="text-xs font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider">
          Workflows
        </span>
        <button className="text-[10px] px-3 py-1 rounded-lg bg-[var(--ctp-surface0)] text-[var(--ctp-overlay1)] hover:text-[var(--ctp-text)]">
          + New Workflow
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Plan tree */}
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
  const statusColor =
    status === "complete"
      ? "var(--ctp-green)"
      : status === "in-progress"
        ? "var(--ctp-yellow)"
        : "var(--ctp-overlay0)";

  return (
    <div style={{ marginLeft: level * 16 }}>
      <div className="flex items-center gap-2 py-1 px-2 rounded hover:bg-[var(--ctp-surface0)]/50 cursor-pointer">
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
      {children}
    </div>
  );
}
