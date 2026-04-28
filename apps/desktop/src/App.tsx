import { useState, useCallback, useRef, useEffect } from "react";
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
import { useKairos } from "./hooks/useKairos";
import { useBackendReady } from "./hooks/useBackendReady";
import { BootSplash } from "./components/BootSplash";
import { useErrorToast } from "./hooks/useErrorToast";
import { useToast } from "./components/Toast";
import { BusinessHarnessView } from "./components/harness/BusinessHarnessView";
import type { ActiveHarness } from "./lib/harness-types";

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
  // Active harness — discriminated union over { none | code | business }.
  // Additive to `currentProject`: when activeHarness.kind === "business",
  // BusinessHarnessView renders in place of the chat workspace; the
  // existing code-project flow continues to use `currentProject` for cwd.
  const [activeHarness, setActiveHarness] = useState<ActiveHarness>({
    kind: "none",
  });
  const [team, setTeam] = useState<TeamAgent[]>([]);

  // State from agent events
  const [activeModel, setActiveModel] = useState("Claude Opus 4.6");
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState("anthropic");
  const [strategy, _setStrategy] = useState("combined");
  const [sessionCost, setSessionCost] = useState(0);
  const [contextPercent, setContextPercent] = useState(0);
  const [permissionMode, _setPermissionMode] = useState<
    "auto" | "confirm" | "plan"
  >("confirm");
  const [activeRole, setActiveRole] = useState<string | null>(null);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [traceEvents, setTraceEvents] = useState<
    import("./components/trace/TraceView").TraceEvent[]
  >([]);
  const traceIdCounter = useRef(0);
  // Routing decisions captured live from chat events. Dashboard Routing tab
  // reads this; capped to the last 200 so long sessions don't bloat memory.
  const [routingDecisions, setRoutingDecisions] = useState<
    import("./components/dashboard/DashboardView").RoutingDecision[]
  >([]);
  const routingIdCounter = useRef(0);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const kairos = useKairos();
  useErrorToast(kairos.error, "KAIROS");

  const toast = useToast();

  // Listen for fatal backend errors (e.g., 3-retry exhaustion) and
  // auto-update notifications. Both ride the same chat-event channel so
  // we do a single listener instead of two.
  useEffect(() => {
    if (!("brainstorm" in window)) return;
    const unlisten = window.brainstorm!.onChatEvent((event: any) => {
      if (event.type === "fatal-error") {
        setFatalError(event.error ?? "Backend process failed permanently");
      } else if (event.type === "update-available") {
        toast.push(
          `Brainstorm ${event.version ?? ""} downloaded — will install on quit.`.trim(),
          "info",
          0, // sticky until dismissed
        );
      }
    });
    return unlisten;
  }, [toast]);

  // Server connection + data
  const serverHealth = useServerHealth();
  // Scope conversations to the active project — list shows only project-
  // matching conversations, create files new ones under it.
  const {
    conversations,
    create: createConversation,
    error: conversationsError,
  } = useConversations({
    projectPath: currentProject,
  });
  // Pipe hook errors to toasts so the user sees them no matter what view
  // is mounted. Each hook exposes a stable `error` string — the helper
  // dedupes via ref so the same error doesn't re-fire every render.
  useErrorToast(conversationsError, "Conversations");

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

  // Gate the main shell on a first-time backend-ready signal. Before this,
  // every data hook fired its mount-time IPC call while the child process
  // was still starting and surfaced "Failed to load X" banners for the
  // first second. useBackendReady stays true across later crashes — those
  // are handled by useBackendRecovery (refetch-only, no splash flash).
  const backendReady = useBackendReady();
  if (!backendReady) {
    return <BootSplash />;
  }

  return (
    <div
      className="flex flex-col h-screen bg-[var(--ctp-crust)]"
      data-testid="app-root"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Title bar — 40px, native traffic lights on macOS */}
      <div
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

      {/* Fatal error banner — backend failed permanently */}
      {fatalError && (
        <div
          data-testid="fatal-error"
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{
            background: "rgba(243, 139, 168, 0.15)",
            borderBottom: "2px solid var(--ctp-red)",
            fontSize: "var(--text-sm)",
            color: "var(--ctp-red)",
          }}
        >
          <span>{fatalError}</span>
        </div>
      )}

      {/* Server disconnected banner */}
      {!fatalError && !serverHealth.connected && !serverHealth.checking && (
        <div
          data-testid="server-disconnected"
          className="flex items-center justify-between px-4 py-2 shrink-0"
          style={{
            background: "var(--glow-red)",
            borderBottom: "1px solid rgba(243, 139, 168, 0.2)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-red)",
          }}
        >
          <span>
            {"brainstorm" in window
              ? "Backend process not responding"
              : "BrainstormServer not running on port 3100"}
          </span>
          <span
            className="font-mono"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            {"brainstorm" in window
              ? "Restarting..."
              : "brainstorm serve --port 3100 --cors"}
          </span>
        </div>
      )}

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
            // Prefer the harness-aware dialog: opens folder picker, walks
            // up looking for business.toml, returns a discriminated result.
            // Falls back to plain folder picker in browser dev mode.
            const bridge = window.brainstorm;
            if (bridge?.openHarnessDialog) {
              const result = await bridge.openHarnessDialog();
              switch (result.kind) {
                case "cancel":
                  return;
                case "business":
                  setActiveHarness({
                    kind: "business",
                    root: result.root,
                    manifest: result.manifest,
                    sessionVerify: null, // populated below
                  });
                  setCurrentProject(result.root);
                  // Open the index session in the background; update the
                  // ActiveHarness when verify completes. Failure is non-fatal
                  // — the harness still renders with sessionVerify=null.
                  if (bridge.openHarnessSession) {
                    bridge
                      .openHarnessSession(result.root)
                      .then((session) => {
                        if (session.ok) {
                          setActiveHarness((prev) =>
                            prev.kind === "business" &&
                            prev.root === result.root
                              ? { ...prev, sessionVerify: session.verify }
                              : prev,
                          );
                        } else {
                          toast.push(
                            `Index session failed: ${session.error}`,
                            "error",
                          );
                        }
                      })
                      .catch((err: unknown) => {
                        toast.push(
                          `Index session error: ${err instanceof Error ? err.message : String(err)}`,
                          "error",
                        );
                      });
                  }
                  return;
                case "code":
                  setActiveHarness({ kind: "code", root: result.root });
                  setCurrentProject(result.root);
                  return;
                case "error":
                  toast.push(
                    `business.toml at ${result.root} failed to load: ${result.message}`,
                    "error",
                  );
                  return;
              }
            } else if (bridge?.openFolder) {
              const path = await bridge.openFolder();
              if (path) {
                setCurrentProject(path);
                setActiveHarness({ kind: "code", root: path });
              }
            } else {
              const path = prompt("Enter project path:");
              if (path) {
                setCurrentProject(path);
                setActiveHarness({ kind: "code", root: path });
              }
            }
          }}
          team={team}
          onTeamChange={setTeam}
          totalBudget={5.0}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onConversationSelect={setActiveConversationId}
          onOpenPalette={() => setPaletteOpen(true)}
          kairosStatus={kairos.status}
          onKairosStart={kairos.start}
          onKairosStop={kairos.stop}
          activeRole={activeRole}
          onNewConversation={async () => {
            const conv = await createConversation();
            if (conv) setActiveConversationId(conv.id);
          }}
        />

        {/* Main panel */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Business harness view takes precedence over mode-switched
              workspace when an active business harness is selected.
              Per the spec: the harness is the primary navigation root;
              its view replaces the chat workspace until dismissed. */}
          {activeHarness.kind === "business" ? (
            <ErrorBoundary fallbackLabel="Business Harness">
              <BusinessHarnessView
                root={activeHarness.root}
                manifest={activeHarness.manifest}
                sessionVerify={activeHarness.sessionVerify}
                onClose={() => {
                  // Close the index session before clearing state so SQLite
                  // WAL mode doesn't leak journal files between sessions.
                  window.brainstorm?.closeHarnessSession?.();
                  setActiveHarness({ kind: "none" });
                }}
              />
            </ErrorBoundary>
          ) : (
            <>
              {/* Chat always mounted to preserve message history across mode switches */}
              <div style={{ display: mode === "chat" ? "contents" : "none" }}>
                <ErrorBoundary fallbackLabel="Chat">
                  <ChatView
                    conversationId={activeConversationId}
                    activeModelId={activeModelId ?? undefined}
                    activeRole={activeRole ?? undefined}
                    activeSkills={activeSkills}
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
                    onAgentEvent={(event) => {
                      // Capture every routing event into routingDecisions so
                      // the Dashboard Routing tab has real data to render.
                      // The trace view captures them too, but this slice is
                      // scoped to model-pick metadata (no tool noise).
                      if (event.type === "routing") {
                        const decision: import("./components/dashboard/DashboardView").RoutingDecision =
                          {
                            id: `route-${routingIdCounter.current++}`,
                            timestamp: Date.now(),
                            modelName:
                              (event as any).modelName ??
                              (event as any).model ??
                              activeModel,
                            provider: (event as any).provider ?? activeProvider,
                            strategy: (event as any).strategy,
                            reason: (event as any).reason,
                            cost: (event as any).cost,
                          };
                        setRoutingDecisions((prev) => [
                          ...prev.slice(-199),
                          decision,
                        ]);
                      }
                      // Capture events for trace view
                      if (
                        [
                          "tool-call-start",
                          "tool-result",
                          "routing",
                          "error",
                        ].includes(event.type)
                      ) {
                        const traceEvent: import("./components/trace/TraceView").TraceEvent =
                          {
                            id: `trace-${traceIdCounter.current++}`,
                            timestamp: Date.now(),
                            agentRole: activeRole ?? "default",
                            agentModel: activeModel,
                            provider: activeProvider,
                            type:
                              event.type === "tool-call-start"
                                ? "tool-call"
                                : event.type === "tool-result"
                                  ? "tool-result"
                                  : event.type === "routing"
                                    ? "routing"
                                    : "error",
                            toolName: event.toolName ?? event.name,
                            toolArgs: event.input
                              ? JSON.stringify(event.input)
                              : undefined,
                            toolOutput: event.output
                              ? String(event.output)
                              : undefined,
                            toolDurationMs: event.durationMs,
                            toolSuccess: event.ok !== false,
                            cost: event.cost,
                          };
                        setTraceEvents((prev) => [
                          ...prev.slice(-499),
                          traceEvent,
                        ]);
                      }
                    }}
                  />
                </ErrorBoundary>
              </div>
              {mode === "plan" && (
                <ErrorBoundary fallbackLabel="Plan">
                  {/* PlanView was rewritten to drop the fake phase pipeline;
                  task selection isn't a real affordance in the new shape
                  (no per-task entities to inspect), so no callback. */}
                  <PlanView />
                </ErrorBoundary>
              )}
              {mode === "trace" && (
                <ErrorBoundary fallbackLabel="Trace">
                  <TraceView
                    events={traceEvents}
                    onEventSelect={(event) => {
                      setDetailOpen(true);
                      setInspectorContext({ type: "trace-event", event });
                    }}
                  />
                </ErrorBoundary>
              )}
              {mode === "dashboard" && (
                <ErrorBoundary fallbackLabel="Dashboard">
                  <DashboardView
                    sessionCost={sessionCost}
                    routingDecisions={routingDecisions}
                  />
                </ErrorBoundary>
              )}
              {mode === "models" && (
                <ErrorBoundary fallbackLabel="Models">
                  <ModelsView
                    onModelSelect={(id, name, prov) => {
                      // Set the routing id too, not just the display name. Without
                      // setActiveModelId, ChatView keeps sending the prior modelId
                      // to the router and the status rail "switch" is cosmetic.
                      setActiveModel(name);
                      setActiveProvider(prov);
                      setActiveModelId(id);
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
                  <SkillsView
                    activeSkills={activeSkills}
                    onActiveSkillsChange={setActiveSkills}
                  />
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
            </>
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
        currentModelId={activeModelId}
        onSelect={(model) => {
          setActiveModel(model.name);
          setActiveModelId(model.id);
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
        onRoleSkills={(skills) => {
          // Role selection now drives activeSkills so the hover-panel skills
          // list is a contract, not decoration. Chat turns sent after this
          // carry the role's skill names; the backend injects those skills'
          // content into the system prompt.
          setActiveSkills(skills);
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
        onModelSwitch={(name, provider, id) => {
          // If the palette entry carries a concrete model id, route future
          // chats to it. Palettes that only know the display name fall back
          // to a lookup against the loaded model list downstream (future
          // work); for now, no id → cosmetic-only like before.
          setActiveModel(name);
          setActiveProvider(provider);
          if (id) setActiveModelId(id);
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
        kairosStatus={kairos.status}
        permissionMode={permissionMode}
        onRoleClick={() => setRolePickerOpen(true)}
        onModelClick={() => setModelSwitcherOpen(true)}
        onStrategyClick={() => {
          // Strategy is determined by the router — read-only display
        }}
        onPermissionClick={() => {
          // Permission mode is read-only — set from brainstorm config
        }}
      />
    </div>
  );
}
