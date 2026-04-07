import type { AppMode } from "../../App";

const MODE_ICONS: Record<AppMode, string> = {
  chat: "💬",
  dashboard: "📊",
  models: "🧠",
  memory: "💾",
  skills: "⚡",
  workflows: "🔀",
  security: "🛡",
  config: "⚙",
};

interface SidebarProps {
  collapsed: boolean;
  activeMode: AppMode;
  onModeChange: (mode: AppMode) => void;
  modeLabels: Record<AppMode, { label: string; shortcut: string }>;
  activeConversationId: string | null;
  onConversationSelect: (id: string | null) => void;
  kairosStatus: "running" | "sleeping" | "paused" | "stopped";
  activeRole: string | null;
}

const KAIROS_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  running: { label: "Running", color: "var(--ctp-green)" },
  sleeping: { label: "Sleeping", color: "var(--ctp-blue)" },
  paused: { label: "Paused", color: "var(--ctp-yellow)" },
  stopped: { label: "Stopped", color: "var(--ctp-overlay0)" },
};

export function Sidebar({
  collapsed,
  activeMode,
  onModeChange,
  modeLabels,
  kairosStatus,
  activeRole,
}: SidebarProps) {
  if (collapsed) {
    return (
      <div className="w-12 bg-[var(--ctp-mantle)] border-r border-[var(--ctp-surface0)] flex flex-col items-center py-2 gap-1 shrink-0">
        {(Object.entries(MODE_ICONS) as [AppMode, string][]).map(
          ([mode, icon]) => (
            <button
              key={mode}
              onClick={() => onModeChange(mode)}
              className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm transition-colors ${
                activeMode === mode
                  ? "bg-[var(--ctp-surface1)] text-[var(--ctp-text)]"
                  : "text-[var(--ctp-overlay0)] hover:bg-[var(--ctp-surface0)] hover:text-[var(--ctp-subtext0)]"
              }`}
              title={modeLabels[mode].label}
            >
              {icon}
            </button>
          ),
        )}
      </div>
    );
  }

  const kairosInfo = KAIROS_STATUS_LABELS[kairosStatus];

  return (
    <div className="w-60 bg-[var(--ctp-mantle)] border-r border-[var(--ctp-surface0)] flex flex-col shrink-0 overflow-hidden">
      {/* Mode tabs */}
      <div className="flex flex-wrap gap-0.5 p-2 border-b border-[var(--ctp-surface0)]">
        {(
          Object.entries(modeLabels) as [
            AppMode,
            { label: string; shortcut: string },
          ][]
        ).map(([mode, { label, shortcut }]) => (
          <button
            key={mode}
            onClick={() => onModeChange(mode)}
            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
              activeMode === mode
                ? "bg-[var(--ctp-surface1)] text-[var(--ctp-text)]"
                : "text-[var(--ctp-overlay0)] hover:text-[var(--ctp-subtext0)]"
            }`}
            title={shortcut}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Conversations */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-medium text-[var(--ctp-overlay0)] uppercase tracking-wider">
              Conversations
            </span>
            <button className="text-[var(--ctp-overlay0)] hover:text-[var(--ctp-text)] text-xs">
              +
            </button>
          </div>

          {/* Placeholder conversations */}
          <div className="space-y-1">
            <div className="p-2 rounded-lg bg-[var(--ctp-surface0)] cursor-pointer">
              <div className="flex items-center gap-2 text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-anthropic)]" />
                <span className="text-[var(--ctp-text)] truncate flex-1">
                  New conversation
                </span>
                <span className="text-[var(--ctp-overlay0)]">now</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* KAIROS widget */}
      <div className="p-2 border-t border-[var(--ctp-surface0)]">
        <div className="p-2 rounded-lg bg-[var(--ctp-surface0)]">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: kairosInfo.color }}
              />
              <span className="font-medium text-[var(--ctp-subtext1)]">
                KAIROS
              </span>
              <span className="text-[10px]" style={{ color: kairosInfo.color }}>
                {kairosInfo.label}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Active role */}
      {activeRole && (
        <div className="px-3 pb-2">
          <div className="text-[10px] text-[var(--ctp-mauve)]">
            {activeRole}
          </div>
        </div>
      )}
    </div>
  );
}
