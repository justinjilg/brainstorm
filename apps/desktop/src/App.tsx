import { useState, useCallback } from "react";
import { Navigator } from "./components/navigator/Navigator";
import type { TeamAgent } from "./components/navigator/TeamBuilder";
import { ChatView } from "./components/chat/ChatView";
import { DashboardView } from "./components/dashboard/DashboardView";
import { ModelsView } from "./components/models/ModelsView";
import { MemoryView } from "./components/memory/MemoryView";
import { SkillsView } from "./components/skills/SkillsView";
import { WorkflowsView } from "./components/workflows/WorkflowsView";
import { SecurityView } from "./components/security/SecurityView";
import { ConfigView } from "./components/config/ConfigView";
import { PlanView } from "./components/plan/PlanView";
import { TraceView } from "./components/trace/TraceView";
import {
  InspectorPanel,
  type InspectorContext,
} from "./components/inspector/InspectorPanel";
import { StatusRail } from "./components/status-rail/StatusRail";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { KeyboardOverlay } from "./components/KeyboardOverlay";
import { RolePicker } from "./components/RolePicker";
import { ModelSwitcher } from "./components/ModelSwitcher";
import { useServerHealth } from "./hooks/useServerHealth";
import { useConversations } from "./hooks/useConversations";

export type AppMode =
  | "chat"
  | "plan"
  | "trace"
  | "dashboard"
  | "models"
  | "memory"
  | "skills"
  | "workflows"
  | "security"
  | "config";

// @ts-expect-error — kept for reference, Navigator has its own mode list
const _MODE_LABELS: Record<AppMode, { label: string; shortcut: string }> = {
  // eslint-disable-line
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [keyboardOverlayOpen, setKeyboardOverlayOpen] = useState(false);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [modelSwitcherOpen, setModelSwitcherOpen] = useState(false);
  const [inspectorContext, setInspectorContext] = useState<InspectorContext>({
    type: "none",
  });

  // Project + team state
  const [currentProject, setCurrentProject] = useState<string | null>(
    null, // Set when user selects a project folder
  );
  const [team, setTeam] = useState<TeamAgent[]>([]);
  const [totalBudget] = useState(5.0);

  // State from agent events
  const [activeModel, setActiveModel] = useState("Claude Opus 4.6");
  const [activeProvider, setActiveProvider] = useState("anthropic");
  const [strategy, setStrategy] = useState("combined");
  const [sessionCost, setSessionCost] = useState(0);
  const [contextPercent, setContextPercent] = useState(0);
  const [permissionMode, setPermissionMode] = useState<
    "auto" | "confirm" | "plan"
  >("confirm");
  const [activeRole, setActiveRole] = useState<string | null>(null);
  const [kairosStatus, setKairosStatus] = useState<
    "running" | "sleeping" | "paused" | "stopped"
  >("stopped");
  void setKairosStatus; // Set by KAIROS SSE events when daemon connects

  // Server connection + data
  const serverHealth = useServerHealth();
  const { conversations, create: createConversation } = useConversations();

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
      if (e.key === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }
      if (e.key === "/" || e.key === "?") {
        e.preventDefault();
        setKeyboardOverlayOpen((prev) => !prev);
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
      {/* Title bar — 40px, native traffic lights on macOS */}
      <div
        data-tauri-drag-region
        className="h-10 flex items-center justify-between shrink-0 bg-[var(--ctp-mantle)]"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        {/* Left: space for macOS traffic lights */}
        <div className="w-20 shrink-0" />

        {/* Center: app name */}
        <span
          className="select-none tracking-[0.15em] uppercase"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
        >
          Brainstorm
        </span>

        {/* Right: connection + model */}
        <div className="w-20 shrink-0 flex items-center justify-end pr-4 gap-2">
          <div
            className="flex items-center gap-1.5"
            title={
              serverHealth.connected
                ? `Connected to BrainstormServer`
                : `Disconnected — server not running on port 3100`
            }
          >
            <span
              className={`w-2 h-2 rounded-full ${serverHealth.connected ? "animate-pulse-glow" : ""}`}
              style={{
                backgroundColor: serverHealth.connected
                  ? "var(--ctp-green)"
                  : "var(--ctp-red)",
              }}
            />
          </div>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Navigator */}
        <Navigator
          collapsed={sidebarCollapsed}
          activeMode={mode}
          onModeChange={setMode}
          currentProject={currentProject}
          recentProjects={[]}
          onProjectSelect={setCurrentProject}
          onOpenFolder={async () => {
            try {
              const { open } = await import("@tauri-apps/plugin-dialog");
              const selected = await open({ directory: true, multiple: false });
              if (selected) setCurrentProject(selected as string);
            } catch {
              // Tauri dialog not available in dev mode
            }
          }}
          team={team}
          onTeamChange={setTeam}
          totalBudget={totalBudget}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onConversationSelect={setActiveConversationId}
          onOpenPalette={() => setPaletteOpen(true)}
          kairosStatus={kairosStatus}
          activeRole={activeRole}
          onNewConversation={async () => {
            const conv = await createConversation();
            if (conv) setActiveConversationId(conv.id);
          }}
        />

        {/* Main panel */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {mode === "chat" && (
            <ErrorBoundary fallbackLabel="Chat">
              <ChatView
                conversationId={activeConversationId}
                onCostUpdate={setSessionCost}
                onModelUpdate={(model, provider) => {
                  setActiveModel(model);
                  setActiveProvider(provider);
                }}
                onContextUpdate={setContextPercent}
                onNewConversation={async () => {
                  const conv = await createConversation();
                  if (conv) setActiveConversationId(conv.id);
                }}
                onModeChange={setMode}
                onOpenPalette={() => setPaletteOpen(true)}
              />
            </ErrorBoundary>
          )}
          {mode === "plan" && (
            <ErrorBoundary fallbackLabel="Plan">
              <PlanView
                plan={null}
                onTaskSelect={(_taskId) => {
                  setDetailOpen(true);
                  // TODO: find task from plan and set inspector context
                  setInspectorContext({ type: "none" });
                }}
                onApprove={(phaseId) => {
                  console.log("Approve phase:", phaseId);
                }}
                onPause={() => {
                  console.log("Plan paused");
                }}
                onResume={() => {
                  console.log("Plan resumed");
                }}
              />
            </ErrorBoundary>
          )}
          {mode === "trace" && (
            <ErrorBoundary fallbackLabel="Trace">
              <TraceView
                events={[]}
                onEventSelect={(event) => {
                  setDetailOpen(true);
                  setInspectorContext({ type: "trace-event", event });
                }}
                onApprove={(eventId) => {
                  console.log("Approved:", eventId);
                }}
                onDeny={(eventId) => {
                  console.log("Denied:", eventId);
                }}
              />
            </ErrorBoundary>
          )}
          {mode === "dashboard" && (
            <ErrorBoundary fallbackLabel="Dashboard">
              <DashboardView sessionCost={sessionCost} />
            </ErrorBoundary>
          )}
          {mode === "models" && (
            <ErrorBoundary fallbackLabel="Models">
              <ModelsView
                onModelSelect={(_id, name, prov) => {
                  setActiveModel(name);
                  setActiveProvider(prov);
                  setMode("chat");
                }}
              />
            </ErrorBoundary>
          )}
          {mode === "memory" && (
            <ErrorBoundary fallbackLabel="Memory">
              <MemoryView />
            </ErrorBoundary>
          )}
          {mode === "skills" && (
            <ErrorBoundary fallbackLabel="Skills">
              <SkillsView />
            </ErrorBoundary>
          )}
          {mode === "workflows" && (
            <ErrorBoundary fallbackLabel="Workflows">
              <WorkflowsView />
            </ErrorBoundary>
          )}
          {mode === "security" && (
            <ErrorBoundary fallbackLabel="Security">
              <SecurityView />
            </ErrorBoundary>
          )}
          {mode === "config" && (
            <ErrorBoundary fallbackLabel="Config">
              <ConfigView />
            </ErrorBoundary>
          )}
        </div>

        {/* Inspector panel */}
        {detailOpen && (
          <InspectorPanel
            context={inspectorContext}
            onClose={() => setDetailOpen(false)}
          />
        )}
      </div>

      {/* Keyboard shortcut overlay */}
      <KeyboardOverlay
        open={keyboardOverlayOpen}
        onClose={() => setKeyboardOverlayOpen(false)}
      />

      {/* Model switcher */}
      <ModelSwitcher
        open={modelSwitcherOpen}
        onClose={() => setModelSwitcherOpen(false)}
        currentModelId={null}
        onSelect={(model) => {
          setActiveModel(model.name);
          setActiveProvider(model.provider);
          setModelSwitcherOpen(false);
        }}
      />

      {/* Role picker */}
      <RolePicker
        open={rolePickerOpen}
        onClose={() => setRolePickerOpen(false)}
        currentRole={activeRole}
        onRoleSelect={(role) => {
          setActiveRole(role);
          setRolePickerOpen(false);
        }}
      />

      {/* Command palette */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onModeChange={(m) => {
          setMode(m);
          setPaletteOpen(false);
        }}
        onToggleSidebar={() => setSidebarCollapsed((prev) => !prev)}
        onToggleDetail={() => setDetailOpen((prev) => !prev)}
        onModelSwitch={(name, provider) => {
          setActiveModel(name);
          setActiveProvider(provider);
        }}
        onRoleSwitch={(roleId) => setActiveRole(roleId)}
        onNewConversation={async () => {
          const conv = await createConversation();
          if (conv) setActiveConversationId(conv.id);
        }}
      />

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
        onRoleClick={() => setRolePickerOpen(true)}
        onModelClick={() => setModelSwitcherOpen(true)}
        onStrategyClick={() => {
          const strategies = [
            "auto",
            "quality",
            "cost",
            "combined",
            "learned",
            "capability",
          ];
          const idx = strategies.indexOf(strategy);
          setStrategy(strategies[(idx + 1) % strategies.length]);
        }}
        onPermissionClick={() =>
          setPermissionMode((prev) =>
            prev === "auto" ? "confirm" : prev === "confirm" ? "plan" : "auto",
          )
        }
      />
    </div>
  );
}
