import { useState, useCallback, useRef, useEffect } from "react";
import { Navigator } from "./components/navigator/Navigator";
import { VerbTabs } from "./components/navigator/VerbTabs";
import type { TeamAgent } from "./components/navigator/TeamBuilder";
import { ChatView } from "./components/chat/ChatView";
import { NewHarnessWizard } from "./components/business/NewHarnessWizard";
import { ConversationWorkspace } from "./components/workspaces/ConversationWorkspace";
import { ProjectWorkspace } from "./components/workspaces/ProjectWorkspace";
import { BusinessWorkspace } from "./components/workspaces/BusinessWorkspace";
import { PlatformWorkspace } from "./components/workspaces/PlatformWorkspace";
import { SelfWorkspace } from "./components/workspaces/SelfWorkspace";
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
import type { ActiveHarness } from "./lib/harness-types";
import {
  ENTITIES,
  VERBS_BY_ENTITY,
  defaultVerbFor,
  isVerbAvailable,
  loadSelection,
  saveSelection,
  type EntityKind,
  type VerbKind,
  type WorkspaceSelection,
} from "./lib/workspace";

/**
 * Legacy mode union, kept ONLY for components that still call setMode with
 * a string (CommandPalette, ChatView, ModelsView). New code should use
 * setSelection({ entity, verb }) directly. The compatibility map below
 * translates AppMode → WorkspaceSelection at the App boundary.
 */
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

const MODE_TO_SELECTION: Record<AppMode, WorkspaceSelection> = {
  chat: { entity: "conversation", verb: "talk" },
  plan: { entity: "project", verb: "plan" },
  trace: { entity: "project", verb: "inspect" },
  dashboard: { entity: "platform", verb: "inspect" },
  models: { entity: "platform", verb: "configure" },
  memory: { entity: "self", verb: "inspect" },
  skills: { entity: "self", verb: "operate" },
  workflows: { entity: "platform", verb: "plan" },
  security: { entity: "platform", verb: "configure" },
  config: { entity: "platform", verb: "configure" },
};

/** Entities for which the Talk verb shows the always-mounted ChatView. */
const TALK_ENTITIES: ReadonlySet<EntityKind> = new Set([
  "conversation",
  "project",
  "business",
]);

export function App() {
  const [selection, setSelection] = useState<WorkspaceSelection>(
    () => loadSelection() ?? { entity: "conversation", verb: "talk" },
  );

  // Persist (entity, verb) across launches. Skipped for transient verbs
  // like "talk" with no harness/project — fine because reload re-evaluates
  // empty states.
  useEffect(() => {
    saveSelection(selection);
  }, [selection]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [keyboardOverlayOpen, setKeyboardOverlayOpen] = useState(false);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [modelSwitcherOpen, setModelSwitcherOpen] = useState(false);
  const [newHarnessWizardOpen, setNewHarnessWizardOpen] = useState(false);
  const [inspectorContext, setInspectorContext] = useState<InspectorContext>({
    type: "none",
  });

  // Project + harness
  const [currentProject, setCurrentProject] = useState<string | null>(null);
  const [activeHarness, setActiveHarness] = useState<ActiveHarness>({
    kind: "none",
  });
  const [team, setTeam] = useState<TeamAgent[]>([]);

  // Agent state
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
  const [routingDecisions, setRoutingDecisions] = useState<
    import("./components/dashboard/DashboardView").RoutingDecision[]
  >([]);
  const routingIdCounter = useRef(0);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const kairos = useKairos();
  useErrorToast(kairos.error, "KAIROS");

  const toast = useToast();

  /**
   * Legacy AppMode setter kept for back-compat with CommandPalette, ChatView,
   * ModelsView etc. — they call setMode("chat") etc. and we map under the
   * hood.
   */
  const setMode = useCallback((mode: AppMode) => {
    setSelection(MODE_TO_SELECTION[mode]);
  }, []);

  /** Switch entity, defaulting to its first available verb. */
  const setEntity = useCallback((entity: EntityKind) => {
    setSelection((prev) =>
      isVerbAvailable(entity, prev.verb)
        ? { entity, verb: prev.verb }
        : { entity, verb: defaultVerbFor(entity) },
    );
  }, []);

  /** Switch verb within the current entity (no-op if verb unavailable). */
  const setVerb = useCallback((verb: VerbKind) => {
    setSelection((prev) =>
      isVerbAvailable(prev.entity, verb) ? { ...prev, verb } : prev,
    );
  }, []);

  // Listen for fatal backend errors + auto-update notifications.
  useEffect(() => {
    if (!("brainstorm" in window)) return;
    const unlisten = window.brainstorm!.onChatEvent((event: any) => {
      if (event.type === "fatal-error") {
        setFatalError(event.error ?? "Backend process failed permanently");
      } else if (event.type === "update-available") {
        toast.push(
          `Brainstorm ${event.version ?? ""} downloaded — will install on quit.`.trim(),
          "info",
          0,
        );
      }
    });
    return unlisten;
  }, [toast]);

  const serverHealth = useServerHealth();
  const {
    conversations,
    create: createConversation,
    error: conversationsError,
  } = useConversations({
    projectPath: currentProject,
  });
  useErrorToast(conversationsError, "Conversations");

  /**
   * Open the harness-aware folder dialog. Detects business.toml on the way
   * up; if found, opens an index session and routes to Business · Plan.
   * Otherwise treats the folder as a code project and routes to
   * Project · Talk.
   */
  const openFolderOrHarness = useCallback(async () => {
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
            sessionVerify: null,
          });
          setCurrentProject(result.root);
          setSelection({ entity: "business", verb: "plan" });
          if (bridge.openHarnessSession) {
            bridge
              .openHarnessSession(result.root)
              .then((session) => {
                if (session.ok) {
                  setActiveHarness((prev) =>
                    prev.kind === "business" && prev.root === result.root
                      ? { ...prev, sessionVerify: session.verify }
                      : prev,
                  );
                } else {
                  toast.push(`Index session failed: ${session.error}`, "error");
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
          setSelection({ entity: "project", verb: "talk" });
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
        setSelection({ entity: "project", verb: "talk" });
      }
    } else {
      const path = prompt("Enter project path:");
      if (path) {
        setCurrentProject(path);
        setActiveHarness({ kind: "code", root: path });
        setSelection({ entity: "project", verb: "talk" });
      }
    }
  }, [toast]);

  const closeActiveHarness = useCallback(() => {
    window.brainstorm?.closeHarnessSession?.();
    setActiveHarness({ kind: "none" });
  }, []);

  const openCreateHarnessWizard = useCallback(() => {
    setNewHarnessWizardOpen(true);
  }, []);

  /**
   * After the wizard scaffolds a new harness on disk, open the index
   * session, parse the manifest into state, and route to Business · Plan
   * so the user lands on the new harness immediately.
   */
  const onHarnessCreated = useCallback(
    async (root: string) => {
      const bridge = window.brainstorm;
      if (!bridge) return;
      try {
        const parsed = await bridge.parseHarness(root);
        if (parsed.kind === "business") {
          setActiveHarness({
            kind: "business",
            root,
            manifest: parsed.manifest,
            sessionVerify: null,
          });
          setCurrentProject(root);
          setSelection({ entity: "business", verb: "plan" });
          // Open the index session in the background — same pattern as
          // openFolderOrHarness.
          bridge
            .openHarnessSession(root)
            .then((session) => {
              if (session.ok) {
                setActiveHarness((prev) =>
                  prev.kind === "business" && prev.root === root
                    ? { ...prev, sessionVerify: session.verify }
                    : prev,
                );
              } else {
                toast.push(`Index session failed: ${session.error}`, "error");
              }
            })
            .catch((err: unknown) => {
              toast.push(
                `Index session error: ${err instanceof Error ? err.message : String(err)}`,
                "error",
              );
            });
        } else if (parsed.kind === "error") {
          toast.push(
            `Harness created but manifest failed to parse: ${parsed.message}`,
            "error",
          );
        }
      } catch (err) {
        toast.push(
          `Failed to load new harness: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
    [toast],
  );

  // Keyboard shortcuts:
  //   Cmd+1..5         → switch entity (Conversation / Project / Business / Platform / Self)
  //   Cmd+Shift+1..5   → switch verb within current entity
  //   Cmd+B / D / K / / — sidebar / detail / palette / shortcut overlay (unchanged)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const num = parseInt(e.key);

      if (num >= 1 && num <= 5) {
        e.preventDefault();
        if (e.shiftKey) {
          const verbs = VERBS_BY_ENTITY[selection.entity];
          const v = verbs[num - 1];
          if (v) setVerb(v);
        } else {
          const entity = ENTITIES[num - 1];
          if (entity) setEntity(entity);
        }
        return;
      }

      if (e.key === "b") {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      } else if (e.key === "d") {
        e.preventDefault();
        setDetailOpen((prev) => !prev);
      } else if (e.key === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (e.key === "/" || e.key === "?") {
        e.preventDefault();
        setKeyboardOverlayOpen((prev) => !prev);
      }
    },
    [selection.entity, setEntity, setVerb],
  );

  const backendReady = useBackendReady();
  if (!backendReady) {
    return <BootSplash />;
  }

  const showChat =
    selection.verb === "talk" && TALK_ENTITIES.has(selection.entity);

  const onTraceEventSelect = (
    event: import("./components/trace/TraceView").TraceEvent,
  ) => {
    setDetailOpen(true);
    setInspectorContext({ type: "trace-event", event });
  };

  return (
    <div
      className="flex flex-col h-screen bg-[var(--ctp-crust)]"
      data-testid="app-root"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Title bar */}
      <div
        className="h-10 flex items-center justify-between shrink-0 bg-[var(--ctp-mantle)]"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        <div className="w-20 shrink-0" />
        <span
          className="select-none tracking-[0.15em] uppercase"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
        >
          Brainstorm
        </span>
        <div className="w-20 shrink-0 flex items-center justify-end pr-4 gap-2">
          <div
            className="flex items-center gap-1.5"
            title={
              serverHealth.connected
                ? "Connected to BrainstormServer"
                : "Disconnected — server not running on port 3100"
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
        <Navigator
          collapsed={sidebarCollapsed}
          activeEntity={selection.entity}
          onEntityChange={setEntity}
          currentProject={currentProject}
          recentProjects={[]}
          onProjectSelect={setCurrentProject}
          onOpenFolder={openFolderOrHarness}
          onOpenHarness={openFolderOrHarness}
          onCreateHarness={openCreateHarnessWizard}
          team={team}
          onTeamChange={setTeam}
          totalBudget={5.0}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onConversationSelect={setActiveConversationId}
          onOpenPalette={() => setPaletteOpen(true)}
          onNewConversation={async () => {
            const conv = await createConversation();
            if (conv) setActiveConversationId(conv.id);
          }}
        />

        {/* Workspace column */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <VerbTabs
            entity={selection.entity}
            activeVerb={selection.verb}
            onSelect={setVerb}
          />

          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* ChatView always mounted to preserve message history across
                entity / verb switches. Visible only when verb=talk on a
                Talk-bearing entity. */}
            <div
              style={{
                display: showChat ? "flex" : "none",
                flex: showChat ? "1 1 auto" : "0 0 0",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
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

            {/* Per-entity workspace body — skipped when chat is visible. */}
            {!showChat && (
              <>
                {selection.entity === "conversation" && (
                  <ConversationWorkspace verb={selection.verb} />
                )}
                {selection.entity === "project" && (
                  <ProjectWorkspace
                    verb={selection.verb}
                    traceEvents={traceEvents}
                    onTraceEventSelect={onTraceEventSelect}
                  />
                )}
                {selection.entity === "business" && (
                  <BusinessWorkspace
                    verb={selection.verb}
                    activeHarness={activeHarness}
                    onCloseHarness={closeActiveHarness}
                    onOpenHarness={openFolderOrHarness}
                    onCreateHarness={openCreateHarnessWizard}
                  />
                )}
                {selection.entity === "platform" && (
                  <PlatformWorkspace
                    verb={selection.verb}
                    sessionCost={sessionCost}
                    routingDecisions={routingDecisions}
                    kairosStatus={kairos.status}
                    onKairosStart={kairos.start}
                    onKairosStop={kairos.stop}
                    onModelSelect={(id, name, prov) => {
                      setActiveModel(name);
                      setActiveProvider(prov);
                      setActiveModelId(id);
                      setSelection({ entity: "conversation", verb: "talk" });
                    }}
                  />
                )}
                {selection.entity === "self" && (
                  <SelfWorkspace
                    verb={selection.verb}
                    activeSkills={activeSkills}
                    onActiveSkillsChange={setActiveSkills}
                    onOpenFolder={openFolderOrHarness}
                    onOpenHarness={openFolderOrHarness}
                    onCreateHarness={openCreateHarnessWizard}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {detailOpen && (
          <InspectorPanel
            context={inspectorContext}
            onClose={() => setDetailOpen(false)}
          />
        )}
      </div>

      <KeyboardOverlay
        open={keyboardOverlayOpen}
        onClose={() => setKeyboardOverlayOpen(false)}
      />

      <NewHarnessWizard
        open={newHarnessWizardOpen}
        onClose={() => setNewHarnessWizardOpen(false)}
        onSubmit={async (params) => {
          const bridge = window.brainstorm;
          if (!bridge?.initHarness) {
            return {
              ok: false,
              error: "Desktop bridge unavailable (initHarness missing)",
            };
          }
          const res = await bridge.initHarness(params);
          if (res.ok) return { ok: true, root: res.root };
          return { ok: false, error: res.error };
        }}
        onCreated={onHarnessCreated}
      />

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

      <RolePicker
        open={rolePickerOpen}
        onClose={() => setRolePickerOpen(false)}
        currentRole={activeRole}
        onRoleSelect={(role) => {
          setActiveRole(role);
          setRolePickerOpen(false);
        }}
        onRoleSkills={(skills) => {
          setActiveSkills(skills);
        }}
      />

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
          /* read-only display */
        }}
        onPermissionClick={() => {
          /* read-only display */
        }}
      />
    </div>
  );
}
