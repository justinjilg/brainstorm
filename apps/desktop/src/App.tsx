import { useState, useCallback } from "react";
import { Sidebar } from "./components/sidebar/Sidebar";
import { ChatView } from "./components/chat/ChatView";
import { StatusRail } from "./components/status-rail/StatusRail";

export type AppMode =
  | "chat"
  | "dashboard"
  | "models"
  | "memory"
  | "skills"
  | "workflows"
  | "security"
  | "config";

const MODE_LABELS: Record<AppMode, { label: string; shortcut: string }> = {
  chat: { label: "Chat", shortcut: "⌘1" },
  dashboard: { label: "Dashboard", shortcut: "⌘2" },
  models: { label: "Models", shortcut: "⌘3" },
  memory: { label: "Memory", shortcut: "⌘4" },
  skills: { label: "Skills", shortcut: "⌘5" },
  workflows: { label: "Workflows", shortcut: "⌘6" },
  security: { label: "Security", shortcut: "⌘7" },
  config: { label: "Config", shortcut: "⌘8" },
};

export function App() {
  const [mode, setMode] = useState<AppMode>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);

  // State from agent events
  const [activeModel, setActiveModel] = useState("Claude Opus 4.6");
  const [activeProvider, setActiveProvider] = useState("anthropic");
  const [strategy, _setStrategy] = useState("combined");
  const [sessionCost, setSessionCost] = useState(0);
  const [contextPercent, setContextPercent] = useState(0);
  const [permissionMode, setPermissionMode] = useState<
    "auto" | "confirm" | "plan"
  >("confirm");
  const [activeRole, _setActiveRole] = useState<string | null>(null);
  const [kairosStatus, _setKairosStatus] = useState<
    "running" | "sleeping" | "paused" | "stopped"
  >("stopped");

  // Suppress unused warnings — these setters wire to SSE events in Phase 1B
  void _setStrategy;
  void _setActiveRole;
  void _setKairosStatus;

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) {
      const modes: AppMode[] = [
        "chat",
        "dashboard",
        "models",
        "memory",
        "skills",
        "workflows",
        "security",
        "config",
      ];
      const num = parseInt(e.key);
      if (num >= 1 && num <= 8) {
        e.preventDefault();
        setMode(modes[num - 1]);
        return;
      }

      if (e.key === "b") {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
        return;
      }
      if (e.key === "d") {
        e.preventDefault();
        setDetailOpen((prev) => !prev);
        return;
      }
    }
  }, []);

  return (
    <div
      className="flex flex-col h-screen bg-[var(--ctp-crust)]"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Title bar drag region */}
      <div
        data-tauri-drag-region
        className="h-8 flex items-center justify-center shrink-0 bg-[var(--ctp-mantle)] border-b border-[var(--ctp-surface0)]"
      >
        <span className="text-xs text-[var(--ctp-overlay0)] select-none">
          Brainstorm Desktop
        </span>
      </div>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          collapsed={sidebarCollapsed}
          activeMode={mode}
          onModeChange={setMode}
          modeLabels={MODE_LABELS}
          activeConversationId={activeConversationId}
          onConversationSelect={setActiveConversationId}
          kairosStatus={kairosStatus}
          activeRole={activeRole}
        />

        {/* Main panel */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {mode === "chat" ? (
            <ChatView
              conversationId={activeConversationId}
              detailOpen={detailOpen}
              onDetailToggle={() => setDetailOpen((prev) => !prev)}
              onCostUpdate={setSessionCost}
              onModelUpdate={(model, provider) => {
                setActiveModel(model);
                setActiveProvider(provider);
              }}
              onContextUpdate={setContextPercent}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[var(--ctp-overlay0)]">
              <div className="text-center">
                <div className="text-2xl mb-2">{MODE_LABELS[mode].label}</div>
                <div className="text-sm">Coming in Phase 2</div>
              </div>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {detailOpen && (
          <div className="w-80 border-l border-[var(--ctp-surface0)] bg-[var(--ctp-mantle)] flex flex-col overflow-hidden">
            <div className="p-3 border-b border-[var(--ctp-surface0)] flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--ctp-subtext0)]">
                Detail
              </span>
              <button
                onClick={() => setDetailOpen(false)}
                className="text-[var(--ctp-overlay0)] hover:text-[var(--ctp-text)] text-xs"
              >
                ⌘D
              </button>
            </div>
            <div className="flex-1 p-3 text-sm text-[var(--ctp-overlay1)]">
              Detail panel appears when tools produce output.
            </div>
          </div>
        )}
      </div>

      {/* Status rail */}
      <StatusRail
        role={activeRole}
        model={activeModel}
        provider={activeProvider}
        strategy={strategy}
        cost={sessionCost}
        contextPercent={contextPercent}
        kairosStatus={kairosStatus}
        permissionMode={permissionMode}
        onRoleClick={() => {}}
        onModelClick={() => {}}
        onStrategyClick={() => {}}
        onPermissionClick={() =>
          setPermissionMode((prev) =>
            prev === "auto" ? "confirm" : prev === "confirm" ? "plan" : "auto",
          )
        }
      />
    </div>
  );
}
