/**
 * God Mode Widget — connected systems status in the sidebar.
 */

interface ConnectedSystem {
  name: string;
  status: "healthy" | "degraded" | "error" | "disconnected";
  tools: number;
  latencyMs?: number;
}

const DEMO_SYSTEMS: ConnectedSystem[] = [
  { name: "BrainstormMSP", status: "healthy", tools: 12, latencyMs: 45 },
  { name: "BrainstormRouter", status: "healthy", tools: 8, latencyMs: 12 },
  { name: "OpenClaw", status: "disconnected", tools: 0 },
];

const STATUS_CONFIG: Record<string, { color: string; icon: string }> = {
  healthy: { color: "var(--ctp-green)", icon: "●" },
  degraded: { color: "var(--ctp-yellow)", icon: "◐" },
  error: { color: "var(--ctp-red)", icon: "✗" },
  disconnected: { color: "var(--ctp-overlay0)", icon: "○" },
};

export function GodModeWidget() {
  const connected = DEMO_SYSTEMS.filter((s) => s.status !== "disconnected");
  const totalTools = DEMO_SYSTEMS.reduce((s, sys) => s + sys.tools, 0);

  return (
    <div className="p-2 border-t border-[var(--ctp-surface0)]">
      <div className="text-[10px] text-[var(--ctp-overlay0)] uppercase tracking-wider px-2 mb-1">
        God Mode · {connected.length} systems · {totalTools} tools
      </div>
      <div className="space-y-0.5">
        {DEMO_SYSTEMS.map((sys) => {
          const cfg = STATUS_CONFIG[sys.status];
          return (
            <div
              key={sys.name}
              className="flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--ctp-surface0)]/50 cursor-pointer text-xs"
            >
              <span style={{ color: cfg.color }}>{cfg.icon}</span>
              <span className="flex-1 text-[var(--ctp-subtext1)] truncate">
                {sys.name}
              </span>
              {sys.tools > 0 && (
                <span className="text-[10px] text-[var(--ctp-overlay0)]">
                  {sys.tools}t
                </span>
              )}
              {sys.latencyMs != null && (
                <span className="text-[10px] text-[var(--ctp-overlay0)]">
                  {sys.latencyMs}ms
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
