/**
 * Navigator — the left panel. Combines project selector, team builder,
 * conversation history, and KAIROS status.
 *
 * Replaces the old Sidebar with a purpose-built navigation experience.
 */

import type { AppMode } from "../../App";
import type { Conversation } from "../../lib/api-client";
import { ProjectSelector } from "./ProjectSelector";
import { TeamBuilder, type TeamAgent } from "./TeamBuilder";
// GodModeWidget available for future use

interface NavigatorProps {
  collapsed: boolean;
  activeMode: AppMode;
  onModeChange: (mode: AppMode) => void;
  // Project
  currentProject: string | null;
  recentProjects: Array<{ path: string; name: string; lastOpened: string }>;
  onProjectSelect: (path: string) => void;
  onOpenFolder: () => void;
  // Team
  team: TeamAgent[];
  onTeamChange: (team: TeamAgent[]) => void;
  totalBudget: number;
  // Conversations
  conversations: Conversation[];
  activeConversationId: string | null;
  onConversationSelect: (id: string | null) => void;
  onNewConversation: () => void;
  // Palette
  onOpenPalette: () => void;
  // KAIROS
  kairosStatus: "running" | "sleeping" | "paused" | "stopped";
  activeRole: string | null;
}

const WORKSPACE_MODES: { mode: AppMode; label: string }[] = [
  { mode: "chat", label: "Chat" },
  { mode: "dashboard", label: "Dashboard" },
  { mode: "models", label: "Models" },
  { mode: "memory", label: "Memory" },
  { mode: "plan", label: "Plan" },
  { mode: "trace", label: "Trace" },
  { mode: "skills", label: "Skills" },
  { mode: "workflows", label: "Workflows" },
  { mode: "security", label: "Security" },
  { mode: "config", label: "Config" },
];

const KAIROS_STATUS: Record<string, { label: string; color: string }> = {
  running: { label: "Running", color: "var(--ctp-green)" },
  sleeping: { label: "Sleeping", color: "var(--ctp-blue)" },
  paused: { label: "Paused", color: "var(--ctp-yellow)" },
  stopped: { label: "Stopped", color: "var(--ctp-overlay0)" },
};

export function Navigator({
  collapsed,
  activeMode,
  onModeChange,
  currentProject,
  recentProjects,
  onProjectSelect,
  onOpenFolder,
  team,
  onTeamChange,
  totalBudget,
  conversations,
  activeConversationId,
  onConversationSelect,
  onNewConversation,
  onOpenPalette: _onOpenPalette,
  kairosStatus,
}: NavigatorProps) {
  void _onOpenPalette; // Available for search box wiring
  const kairosInfo = KAIROS_STATUS[kairosStatus];

  if (collapsed) {
    return (
      <div
        className="flex flex-col items-center py-4 gap-2 shrink-0"
        style={{
          width: 56,
          background: "var(--ctp-mantle)",
          borderRight: "1px solid var(--border-subtle)",
        }}
      >
        {WORKSPACE_MODES.slice(0, 5).map(({ mode, label }) => (
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
            title={label}
          >
            {label.charAt(0)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col shrink-0 overflow-hidden"
      style={{
        width: 280,
        background: "var(--ctp-mantle)",
        borderRight: "1px solid var(--border-subtle)",
        transition: "width var(--duration-normal) var(--ease-out)",
      }}
    >
      {/* Project Selector */}
      <ProjectSelector
        currentProject={currentProject}
        recentProjects={recentProjects}
        onProjectSelect={onProjectSelect}
        onOpenFolder={onOpenFolder}
      />

      {/* Workspace modes */}
      <div className="px-3 py-1">
        <div className="flex flex-wrap gap-1">
          {WORKSPACE_MODES.map(({ mode, label }) => (
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
              title={`⌘${WORKSPACE_MODES.indexOf({ mode, label } as any) + 1}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div
        style={{
          borderBottom: "1px solid var(--border-subtle)",
          margin: "4px 12px",
        }}
      />

      {/* Team Builder */}
      <TeamBuilder
        team={team}
        onTeamChange={onTeamChange}
        totalBudget={totalBudget}
      />

      {/* Divider */}
      <div
        style={{
          borderBottom: "1px solid var(--border-subtle)",
          margin: "4px 12px",
        }}
      />

      {/* Conversations */}
      <div
        className="px-4 py-1.5"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        History
      </div>
      <div className="flex-1 overflow-y-auto px-2">
        {conversations.length === 0 ? (
          <div
            className="px-3 py-3 text-center"
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            No conversations yet
          </div>
        ) : (
          conversations.map((conv) => {
            const isActive = activeConversationId === conv.id;
            return (
              <div
                key={conv.id}
                onClick={() => onConversationSelect(conv.id)}
                className="interactive flex items-center gap-2 px-3 py-2 rounded-xl mb-0.5"
                style={{
                  background: isActive ? "var(--ctp-surface0)" : "transparent",
                  borderLeft: isActive
                    ? "2px solid var(--ctp-mauve)"
                    : "2px solid transparent",
                }}
              >
                <div className="flex-1 min-w-0">
                  <div
                    className="truncate"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ctp-text)",
                    }}
                  >
                    {conv.name || "Untitled"}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* KAIROS + Systems */}
      <div
        className="px-3 py-2"
        style={{ borderTop: "1px solid var(--border-subtle)" }}
      >
        <div
          onClick={() => onModeChange("config")}
          className="interactive flex items-center gap-2 px-3 py-2 rounded-xl"
          style={{
            background: "var(--ctp-surface0)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <span
            className={`w-2 h-2 rounded-full ${kairosStatus === "running" ? "animate-pulse-glow" : ""}`}
            style={{ background: kairosInfo.color }}
          />
          <span
            className="font-medium"
            style={{ fontSize: "var(--text-xs)", color: "var(--ctp-subtext1)" }}
          >
            KAIROS
          </span>
          <span
            style={{
              fontSize: "var(--text-2xs)",
              color: kairosInfo.color,
            }}
          >
            {kairosInfo.label}
          </span>
        </div>
      </div>

      {/* New conversation */}
      <div
        className="px-3 pb-3"
        style={{ borderTop: "1px solid var(--border-subtle)" }}
      >
        <button
          onClick={onNewConversation}
          className="interactive w-full flex items-center justify-between px-3 py-2 rounded-xl"
          style={{
            border: "1px solid var(--border-default)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-subtext0)",
          }}
        >
          <span>+ New Conversation</span>
          <span
            className="font-mono"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            ⌘N
          </span>
        </button>
      </div>
    </div>
  );
}
