/**
 * Navigator — left panel.
 *
 * Replaces the flat 10-mode layout with a hybrid entity-first structure:
 * the EntityRail picks the subject (Conversation / Project / Business /
 * Platform / Self); per-entity content renders below it. Verb tabs render
 * at the top of the workspace itself, not in the Navigator.
 *
 * KAIROS status display stays glanceable via the StatusRail (bottom of
 * the app, separate component); start/stop controls have moved into
 * Platform · Operate.
 */

import { ProjectSelector } from "./ProjectSelector";
import { TeamBuilder, type TeamAgent } from "./TeamBuilder";
import { EntityRail } from "./EntityRail";
import type { Conversation } from "../../lib/api-client";
import type { EntityKind } from "../../lib/workspace";

interface NavigatorProps {
  collapsed: boolean;
  activeEntity: EntityKind;
  onEntityChange: (entity: EntityKind) => void;
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
  // Business — Group C wires onCreateHarness to the wizard
  onOpenHarness?: () => void;
  onCreateHarness?: () => void;
}

export function Navigator({
  collapsed,
  activeEntity,
  onEntityChange,
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
  onOpenPalette,
  onOpenHarness,
  onCreateHarness,
}: NavigatorProps) {
  if (collapsed) {
    return (
      <div
        className="flex flex-col items-center shrink-0"
        style={{
          width: 56,
          background: "var(--ctp-mantle)",
          borderRight: "1px solid var(--border-subtle)",
        }}
      >
        <EntityRail
          active={activeEntity}
          onSelect={onEntityChange}
          collapsed={true}
        />
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
      {/* Search / Command bar */}
      <div className="px-3 pt-3 pb-2">
        <div
          onClick={onOpenPalette}
          data-testid="search-bar"
          className="interactive flex items-center gap-2 px-3 h-8 rounded-lg"
          style={{
            background: "var(--ctp-surface0)",
            border: "1px solid var(--border-subtle)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-overlay0)",
          }}
        >
          <span style={{ fontSize: "var(--text-2xs)" }}>⌘K</span>
          <span>Search commands...</span>
        </div>
      </div>

      {/* Entity rail */}
      <EntityRail
        active={activeEntity}
        onSelect={onEntityChange}
        collapsed={false}
      />

      {/* Per-entity content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeEntity === "conversation" && (
          <ConversationContent
            conversations={conversations}
            activeConversationId={activeConversationId}
            onConversationSelect={onConversationSelect}
            onNewConversation={onNewConversation}
          />
        )}
        {activeEntity === "project" && (
          <ProjectContent
            currentProject={currentProject}
            recentProjects={recentProjects}
            onProjectSelect={onProjectSelect}
            onOpenFolder={onOpenFolder}
          />
        )}
        {activeEntity === "business" && (
          <BusinessContent
            onOpenHarness={onOpenHarness ?? onOpenFolder}
            onCreateHarness={onCreateHarness}
          />
        )}
        {/* Platform and Self have no per-Navigator content — their
            workspaces carry everything. Leave the area empty so the
            user's eye lands on the verb tabs in the workspace itself. */}
      </div>

      {/* Divider */}
      <div
        style={{
          borderBottom: "1px solid var(--border-subtle)",
          margin: "0 12px",
        }}
      />

      {/* Team Builder — always visible, cross-cutting */}
      <TeamBuilder
        team={team}
        onTeamChange={onTeamChange}
        totalBudget={totalBudget}
      />
    </div>
  );
}

// ── Per-entity Navigator content ───────────────────────────────────

function ConversationContent({
  conversations,
  activeConversationId,
  onConversationSelect,
  onNewConversation,
}: {
  conversations: Conversation[];
  activeConversationId: string | null;
  onConversationSelect: (id: string | null) => void;
  onNewConversation: () => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="px-3 pb-2">
        <button
          onClick={onNewConversation}
          data-testid="new-conversation"
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
      <div className="px-2">
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
                data-testid={`conversation-${conv.id}`}
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
    </div>
  );
}

function ProjectContent({
  currentProject,
  recentProjects,
  onProjectSelect,
  onOpenFolder,
}: {
  currentProject: string | null;
  recentProjects: Array<{ path: string; name: string; lastOpened: string }>;
  onProjectSelect: (path: string) => void;
  onOpenFolder: () => void;
}) {
  return (
    <ProjectSelector
      currentProject={currentProject}
      recentProjects={recentProjects}
      onProjectSelect={onProjectSelect}
      onOpenFolder={onOpenFolder}
    />
  );
}

function BusinessContent({
  onOpenHarness,
  onCreateHarness,
}: {
  onOpenHarness: () => void;
  onCreateHarness?: () => void;
}) {
  return (
    <div className="px-3 py-2 flex flex-col gap-2">
      <button
        onClick={onOpenHarness}
        className="interactive w-full px-3 py-2 rounded-xl text-left"
        style={{
          background: "var(--ctp-surface0)",
          border: "1px solid var(--border-subtle)",
          fontSize: "var(--text-xs)",
          color: "var(--ctp-text)",
        }}
      >
        Open existing harness
      </button>
      {onCreateHarness ? (
        <button
          onClick={onCreateHarness}
          className="interactive w-full px-3 py-2 rounded-xl text-left"
          style={{
            background: "var(--ctp-blue)",
            border: "1px solid var(--ctp-blue)",
            fontSize: "var(--text-xs)",
            fontWeight: 600,
            color: "var(--ctp-base)",
          }}
        >
          Create new harness
        </button>
      ) : (
        <div
          style={{
            padding: "8px 10px",
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay0)",
            background: "var(--ctp-base)",
            border: "1px dashed var(--border-subtle)",
            borderRadius: 8,
          }}
        >
          Create-new wizard ships in Group C.
        </div>
      )}
    </div>
  );
}
