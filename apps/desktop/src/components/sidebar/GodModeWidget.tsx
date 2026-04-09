/**
 * God Mode Widget — connected systems status in the sidebar.
 * Shows real connection state from the health endpoint.
 */

import { useHealthStats } from "../../hooks/useServerData";

const STATUS_CONFIG: Record<string, { color: string; icon: string }> = {
  healthy: { color: "var(--ctp-green)", icon: "●" },
  degraded: { color: "var(--ctp-yellow)", icon: "◐" },
  error: { color: "var(--ctp-red)", icon: "✗" },
  disconnected: { color: "var(--ctp-overlay0)", icon: "○" },
};

export function GodModeWidget() {
  const health = useHealthStats(10000);

  const godMode = health?.god_mode;
  const connected = godMode?.connected ?? 0;
  const tools = godMode?.tools ?? 0;
  const isConnected = connected > 0;

  return (
    <div className="p-2 border-t border-[var(--ctp-surface0)]">
      <div className="text-[10px] text-[var(--ctp-overlay0)] uppercase tracking-wider px-2 mb-1">
        God Mode · {connected} system{connected !== 1 ? "s" : ""} · {tools} tool
        {tools !== 1 ? "s" : ""}
      </div>
      <div className="px-2 py-1">
        {isConnected ? (
          <div className="flex items-center gap-2 text-xs">
            <span style={{ color: STATUS_CONFIG.healthy.color }}>
              {STATUS_CONFIG.healthy.icon}
            </span>
            <span className="text-[var(--ctp-subtext1)]">
              {connected} connected · {tools} tools available
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs">
            <span style={{ color: STATUS_CONFIG.disconnected.color }}>
              {STATUS_CONFIG.disconnected.icon}
            </span>
            <span className="text-[var(--ctp-overlay0)]">
              No systems connected
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
