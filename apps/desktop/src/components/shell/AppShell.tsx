/**
 * AppShell — the flagship "Vivarium" shell.
 *
 * Replaces the 826-line App god-object and its 5×5 entity×verb grid with a calm
 * canvas + a slim rail + an openable Pulse feed. The app opens on Talk (never on
 * Pulse); the organism glows at the edge (the rail-heart) and opens as a
 * slide-over on demand. Cmd+1..3 move between canvas places, ⌘0 / the heart open
 * Pulse, ⌘, opens Settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rail } from "./Rail";
import { PulseFeed } from "./PulseFeed";
import { SettingsDrawer } from "./SettingsDrawer";
import { TalkPlace } from "../../places/TalkPlace";
import { CouncilPlace } from "../../places/CouncilPlace";
import { GrowthPlace } from "../../places/GrowthPlace";
import { DEFAULT_PLACE, type PlaceId } from "../../places/registry";
import { ErrorBoundary } from "../ErrorBoundary";
import { StatusRail } from "../status-rail/StatusRail";
import { ModelSwitcher } from "../ModelSwitcher";
import { CommandPalette } from "../CommandPalette";
import { KeyboardOverlay } from "../KeyboardOverlay";
import { RolePicker } from "../RolePicker";
import { useKairos } from "../../hooks/useKairos";
import { useOrganism } from "../../hooks/useOrganism";
import { useSession } from "../../hooks/useSession";
import { useErrorToast } from "../../hooks/useErrorToast";

export function AppShell() {
  const [place, setPlace] = useState<PlaceId>(DEFAULT_PLACE);
  const [pulseOpen, setPulseOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    "models" | "config" | "security"
  >("models");

  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [currentProject, setCurrentProject] = useState<string | null>(null);

  // The operator's low-frequency config as one cohesive slice.
  const session = useSession();
  // High-frequency live readouts kept SEPARATE so a cost/context tick re-renders
  // only the StatusRail, never the session config consumers or the heavy canvas.
  const [sessionCost, setSessionCost] = useState(0);
  const [contextPercent, setContextPercent] = useState(0);

  const [modelSwitcherOpen, setModelSwitcherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [keyboardOverlayOpen, setKeyboardOverlayOpen] = useState(false);
  const [rolePickerOpen, setRolePickerOpen] = useState(false);

  // KAIROS ignites the moment the shell mounts (backend readiness is gated
  // upstream in App.tsx, so mounting means the backend is up).
  const kairos = useKairos({ autoStart: true });
  useErrorToast(kairos.error, "KAIROS");

  // Pulse "unseen" marker: the highest seq the user has seen vs. the live max.
  const { feed } = useOrganism();
  const maxSeq = feed.length > 0 ? feed[0].seq : 0;
  const lastSeenSeqRef = useRef(0);
  const [hasUnseen, setHasUnseen] = useState(false);
  useEffect(() => {
    setHasUnseen(maxSeq > lastSeenSeqRef.current && !pulseOpen);
  }, [maxSeq, pulseOpen]);

  const openSettings = useCallback((tab?: "models" | "config" | "security") => {
    if (tab) setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);
  const openPulse = useCallback(() => {
    setPulseOpen(true);
    lastSeenSeqRef.current = maxSeq;
    setHasUnseen(false);
  }, [maxSeq]);
  const markPulseSeen = useCallback(() => {
    lastSeenSeqRef.current = maxSeq;
    setHasUnseen(false);
  }, [maxSeq]);

  const openFolder = useCallback(async () => {
    const bridge = window.brainstorm;
    if (!bridge) return;
    try {
      if (bridge.openHarnessDialog) {
        const r = await bridge.openHarnessDialog();
        if (r.kind === "code" || r.kind === "business")
          setCurrentProject(r.root);
      } else if (bridge.openFolder) {
        const path = await bridge.openFolder();
        if (path) setCurrentProject(path);
      }
    } catch {
      /* dialog cancelled or unavailable */
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        if (settingsOpen) return setSettingsOpen(false);
        if (pulseOpen) return setPulseOpen(false);
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      switch (e.key) {
        case "1":
          e.preventDefault();
          setPlace("talk");
          break;
        case "2":
          e.preventDefault();
          setPlace("council");
          break;
        case "3":
          e.preventDefault();
          setPlace("growth");
          break;
        case "0":
          e.preventDefault();
          pulseOpen ? setPulseOpen(false) : openPulse();
          break;
        case ",":
          e.preventDefault();
          openSettings();
          break;
        case "k":
          e.preventDefault();
          setPaletteOpen((v) => !v);
          break;
        case "m":
          e.preventDefault();
          setModelSwitcherOpen((v) => !v);
          break;
        case "/":
        case "?":
          e.preventDefault();
          setKeyboardOverlayOpen((v) => !v);
          break;
        default:
          break;
      }
    },
    [settingsOpen, pulseOpen, openPulse, openSettings],
  );

  const canvas = useMemo(() => {
    switch (place) {
      case "talk":
        return (
          <TalkPlace
            conversationId={activeConversationId}
            onConversationSelect={setActiveConversationId}
            currentProject={currentProject}
            onOpenFolder={openFolder}
            activeModelId={session.modelId ?? undefined}
            activeRole={session.role ?? undefined}
            activeSkills={session.skills}
            onCostUpdate={setSessionCost}
            onModelUpdate={session.reflectModel}
            onContextUpdate={setContextPercent}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenModels={() => setModelSwitcherOpen(true)}
          />
        );
      case "council":
        return <CouncilPlace />;
      case "growth":
        return (
          <GrowthPlace
            activeSkills={session.skills}
            onActiveSkillsChange={session.setSkills}
          />
        );
      default:
        return null;
    }
    // Depend only on the fields the canvas actually reads — NOT the whole
    // session object. cost/contextPercent tick frequently and are consumed by
    // the StatusRail, not the canvas; excluding them keeps the heavy canvas
    // (ChatView / places) from re-rendering on every cost update. The setters
    // and reflectModel are stable (useCallback).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    place,
    activeConversationId,
    currentProject,
    session.modelId,
    session.role,
    session.skills,
  ]);

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: "var(--ctp-crust)" }}
      data-testid="app-shell"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="flex flex-1 overflow-hidden relative">
        <Rail
          active={place}
          onSelect={setPlace}
          onOpenPulse={openPulse}
          onOpenSettings={() => openSettings()}
          pulseActive={pulseOpen}
          pulseHasUnseen={hasUnseen}
        />

        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <ErrorBoundary fallbackLabel={place}>{canvas}</ErrorBoundary>
        </main>

        <PulseFeed
          open={pulseOpen}
          onClose={() => setPulseOpen(false)}
          onSeen={markPulseSeen}
        />
        <SettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          initialTab={settingsTab}
          onModelSelect={session.selectModel}
        />
      </div>

      <StatusRail
        role={session.role}
        model={session.model}
        provider={session.provider}
        strategy="combined"
        cost={sessionCost}
        contextPercent={contextPercent}
        kairosStatus={kairos.status}
        permissionMode="confirm"
        onRoleClick={() => setRolePickerOpen(true)}
        onModelClick={() => setModelSwitcherOpen(true)}
        onStrategyClick={() => {}}
        onPermissionClick={() => {}}
      />

      <ModelSwitcher
        open={modelSwitcherOpen}
        onClose={() => setModelSwitcherOpen(false)}
        currentModelId={session.modelId}
        onSelect={(model) => {
          session.selectModel(model.id, model.name, model.provider);
          setModelSwitcherOpen(false);
        }}
      />
      <RolePicker
        open={rolePickerOpen}
        onClose={() => setRolePickerOpen(false)}
        currentRole={session.role}
        onRoleSelect={(role) => {
          session.setRole(role);
          setRolePickerOpen(false);
        }}
        onRoleSkills={(skills) => session.setSkills(skills)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(p) => {
          setPlace(p);
          setPaletteOpen(false);
        }}
        onOpenSettings={(tab) => {
          openSettings(tab);
          setPaletteOpen(false);
        }}
        onOpenPulse={() => {
          openPulse();
          setPaletteOpen(false);
        }}
        onModelSwitch={(name, provider, id) =>
          id
            ? session.selectModel(id, name, provider)
            : session.reflectModel(name, provider)
        }
        onRoleSwitch={(roleId) => session.setRole(roleId)}
        onNewConversation={() => setPlace("talk")}
      />
      <KeyboardOverlay
        open={keyboardOverlayOpen}
        onClose={() => setKeyboardOverlayOpen(false)}
      />
    </div>
  );
}
