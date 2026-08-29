/**
 * Talk — the calm home. Your work: chat threads over a project.
 *
 * This is where the app opens (never on Pulse). It's the surviving chat loop
 * (ChatView, always-mounted upstream to preserve history) plus a lean thread
 * sidebar. Project context attaches HERE — opening a folder gives the organism a
 * workspace — rather than being a separate entity in a grid. The organism is
 * present only as the ambient rail edge; this canvas stays quiet and does not
 * animate.
 */
import { ChatView } from "../components/chat/ChatView";
import { useConversations } from "../hooks/useConversations";

export interface TalkPlaceProps {
  conversationId: string | null;
  onConversationSelect: (id: string | null) => void;
  currentProject: string | null;
  onOpenFolder: () => void;
  activeModelId?: string;
  activeRole?: string;
  activeSkills: string[];
  onCostUpdate: (cost: number) => void;
  onModelUpdate: (model: string, provider: string) => void;
  onContextUpdate: (percent: number) => void;
  onOpenPalette: () => void;
  /** Legacy escape hatch from ChatView (e.g. "open models"); AppShell maps it. */
  onLegacyMode: (mode: string) => void;
}

export function TalkPlace({
  conversationId,
  onConversationSelect,
  currentProject,
  onOpenFolder,
  activeModelId,
  activeRole,
  activeSkills,
  onCostUpdate,
  onModelUpdate,
  onContextUpdate,
  onOpenPalette,
  onLegacyMode,
}: TalkPlaceProps) {
  const { conversations, create } = useConversations({
    projectPath: currentProject,
  });

  const newConversation = async () => {
    const conv = await create();
    if (conv) onConversationSelect(conv.id);
  };

  const projectName = currentProject
    ? currentProject.split(/[\\/]/).filter(Boolean).pop()
    : null;

  return (
    <div className="flex flex-1 min-w-0 overflow-hidden">
      {/* Thread sidebar */}
      <aside
        className="shrink-0 flex flex-col"
        style={{
          width: 220,
          background: "var(--ctp-base)",
          borderRight: "1px solid var(--border-subtle)",
        }}
      >
        <div className="px-3 pt-3 pb-2">
          <button
            onClick={onOpenFolder}
            className="w-full text-left px-2 py-1.5 rounded truncate hover:brightness-125"
            title={
              currentProject ?? "Open a folder to give the organism a workspace"
            }
            style={{
              fontSize: "var(--text-xs)",
              background: "var(--ctp-surface0)",
              border: "1px solid var(--border-subtle)",
              color: projectName ? "var(--ctp-text)" : "var(--ctp-overlay1)",
            }}
          >
            {projectName ? `▤ ${projectName}` : "＋ Open folder…"}
          </button>
        </div>
        <div className="px-3 pb-2">
          <button
            onClick={newConversation}
            data-testid="new-thread"
            className="w-full px-2 py-1.5 rounded hover:brightness-125"
            style={{
              fontSize: "var(--text-xs)",
              background: "var(--ctp-surface0)",
              border: "1px solid var(--border-subtle)",
              color: "var(--ctp-subtext1)",
            }}
          >
            ＋ New thread
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2">
          {conversations.length === 0 && (
            <div
              className="px-2 py-4 text-center"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
              }}
            >
              No threads yet.
            </div>
          )}
          {conversations.map((c) => {
            const isActive = c.id === conversationId;
            return (
              <button
                key={c.id}
                onClick={() => onConversationSelect(c.id)}
                className="w-full text-left px-2 py-1.5 rounded truncate mb-0.5"
                style={{
                  fontSize: "var(--text-xs)",
                  background: isActive ? "var(--ctp-surface0)" : "transparent",
                  color: isActive ? "var(--ctp-text)" : "var(--ctp-subtext0)",
                }}
              >
                {c.name || c.id.slice(0, 8)}
              </button>
            );
          })}
        </div>
      </aside>

      {/* Chat canvas */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <ChatView
          conversationId={conversationId}
          activeModelId={activeModelId}
          activeRole={activeRole}
          activeSkills={activeSkills}
          onCostUpdate={onCostUpdate}
          onModelUpdate={onModelUpdate}
          onContextUpdate={onContextUpdate}
          onNewConversation={newConversation}
          onOpenPalette={onOpenPalette}
          onModeChange={(mode: string) => onLegacyMode(mode)}
        />
      </div>
    </div>
  );
}
