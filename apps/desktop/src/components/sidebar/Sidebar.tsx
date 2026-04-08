import type { AppMode } from "../../App";
import { GodModeWidget } from "./GodModeWidget";

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

const KAIROS_STATUS: Record<string, { label: string; color: string }> = {
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
  const kairosInfo = KAIROS_STATUS[kairosStatus];

  if (collapsed) {
    return (
      <div
        className="flex flex-col items-center py-4 gap-2 shrink-0"
        style={{
          width: 56,
          background: "var(--ctp-mantle)",
          borderRight: "1px solid var(--border-subtle)",
          transition: "width var(--duration-normal) var(--ease-out)",
        }}
      >
        {(Object.keys(modeLabels) as AppMode[]).slice(0, 5).map((mode) => (
          <button
            key={mode}
            onClick={() => onModeChange(mode)}
            className="interactive w-10 h-10 rounded-xl flex items-center justify-center"
            style={{
              fontSize: "var(--text-xs)",
              color:
                activeMode === mode ? "var(--ctp-text)" : "var(--ctp-overlay0)",
              background:
                activeMode === mode ? "var(--ctp-surface0)" : "transparent",
            }}
            title={modeLabels[mode].label}
          >
            {modeLabels[mode].label.charAt(0)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col shrink-0 overflow-hidden"
      style={{
        width: 260,
        background: "var(--ctp-mantle)",
        borderRight: "1px solid var(--border-subtle)",
        transition: "width var(--duration-normal) var(--ease-out)",
      }}
    >
      {/* Search */}
      <div className="px-3 pt-4 pb-2">
        <div
          className="flex items-center gap-2 px-3 h-8 rounded-lg"
          style={{
            background: "var(--ctp-surface0)",
            border: "1px solid var(--border-subtle)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-overlay0)",
          }}
        >
          <span style={{ fontSize: "var(--text-2xs)" }}>⌘K</span>
          <span>Search...</span>
        </div>
      </div>

      {/* Mode nav */}
      <div className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {(
            Object.entries(modeLabels) as [
              AppMode,
              { label: string; shortcut: string },
            ][]
          ).map(([mode, { label, shortcut }]) => (
            <button
              key={mode}
              onClick={() => onModeChange(mode)}
              className="interactive px-2 py-1 rounded-md"
              style={{
                fontSize: "var(--text-2xs)",
                color:
                  activeMode === mode
                    ? "var(--ctp-text)"
                    : "var(--ctp-overlay0)",
                background:
                  activeMode === mode ? "var(--ctp-surface0)" : "transparent",
              }}
              title={shortcut}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Section: Conversations */}
      <SectionHeader title="Conversations" />
      <div className="flex-1 overflow-y-auto px-2">
        {/* Active conversation */}
        <div
          className="interactive flex items-center gap-3 px-3 py-3 rounded-xl mb-1"
          style={{
            background: "var(--ctp-surface0)",
            borderLeft: "2px solid var(--ctp-mauve)",
          }}
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: "var(--color-anthropic)" }}
          />
          <div className="flex-1 min-w-0">
            <div
              className="truncate text-[var(--ctp-text)]"
              style={{ fontSize: "var(--text-sm)" }}
            >
              New conversation
            </div>
            <div
              className="text-[var(--ctp-overlay0)]"
              style={{ fontSize: "var(--text-2xs)" }}
            >
              Claude Opus 4.6
            </div>
          </div>
          <span
            className="text-[var(--ctp-overlay0)] shrink-0"
            style={{ fontSize: "var(--text-2xs)" }}
          >
            now
          </span>
        </div>
      </div>

      {/* Section: KAIROS */}
      <SectionHeader title="KAIROS" />
      <div className="px-3 pb-2">
        <div
          className="px-3 py-2.5 rounded-xl"
          style={{
            background: "var(--ctp-surface0)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${kairosStatus === "running" ? "animate-pulse-glow" : ""}`}
                style={{ background: kairosInfo.color }}
              />
              <span
                className="font-medium text-[var(--ctp-subtext1)]"
                style={{ fontSize: "var(--text-xs)" }}
              >
                {kairosInfo.label}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Section: Systems */}
      <GodModeWidget />

      {/* Active role badge */}
      {activeRole && (
        <div className="px-4 pb-3">
          <div
            className="text-[var(--ctp-mauve)]"
            style={{ fontSize: "var(--text-2xs)" }}
          >
            ● {activeRole}
          </div>
        </div>
      )}

      {/* New conversation button */}
      <div
        className="px-3 py-3"
        style={{ borderTop: "1px solid var(--border-subtle)" }}
      >
        <button
          className="interactive w-full flex items-center justify-between px-3 py-2 rounded-xl"
          style={{
            border: "1px solid var(--border-default)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-subtext0)",
          }}
        >
          <span>+ New Conversation</span>
          <span
            className="font-mono text-[var(--ctp-overlay0)]"
            style={{ fontSize: "var(--text-2xs)" }}
          >
            ⌘N
          </span>
        </button>
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div
      className="px-4 py-2"
      style={{
        fontSize: "var(--text-2xs)",
        color: "var(--ctp-overlay0)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      }}
    >
      {title}
    </div>
  );
}
