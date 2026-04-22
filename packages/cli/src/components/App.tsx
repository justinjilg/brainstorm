/**
 * Top-level App — Mode switcher for the multi-pane TUI.
 *
 * Renders ModeBar + active mode content + KeyHint.
 * Mode 1 (Chat) delegates to ChatApp. Other modes are dashboard views.
 */

import React, { useState, useRef } from "react";
import { Box, useApp, useInput } from "ink";
import { useMode, type TUIMode } from "../hooks/useMode.js";
import { useBRData } from "../hooks/useBRData.js";
import { ModeBar } from "./ModeBar.js";
import { KeyHint } from "./KeyHint.js";
import { ChatApp } from "./ChatApp.js";
import { DashboardMode } from "./modes/DashboardMode.js";
import { ModelsMode } from "./modes/ModelsMode.js";
import { ConfigMode } from "./modes/ConfigMode.js";
import { PlanningMode } from "./modes/PlanningMode.js";
import { ShortcutOverlay } from "./ShortcutOverlay.js";
import type { AgentEvent, AgentTask } from "@brainst0rm/shared";

interface AppProps {
  // Chat mode props (passed through to ChatApp)
  strategy: string;
  modelCount: { local: number; cloud: number };
  onSendMessage: (text: string) => AsyncGenerator<AgentEvent>;
  onAbort?: () => void;
  slashCallbacks?: any;
  // Data for other modes
  models?: Array<{
    id: string;
    name: string;
    provider: string;
    qualityTier: number;
    speedTier: number;
    pricing: { input: number; output: number };
    status: string;
  }>;
  configInfo?: {
    strategy: string;
    permissionMode: string;
    outputStyle: string;
    sandbox: string;
  };
  vaultInfo?: {
    exists: boolean;
    isOpen: boolean;
    keyCount: number;
    keys: string[];
    createdAt: string | null;
    opAvailable: boolean;
    resolvedKeys: string[];
  };
  /** BrainstormRouter gateway client for dashboard data */
  gateway?: any;
  /** Memory info for Config mode */
  memoryInfo?: { localCount: number; types: Record<string, number> };
  /** God Mode connection data for Dashboard */
  godModeInfo?: {
    connectedSystems: Array<{
      name: string;
      displayName: string;
      capabilities: string[];
      latencyMs: number;
      toolCount: number;
    }>;
    errors: Array<{ name: string; error: string }>;
    totalTools: number;
  };
  /** Opt-in flag from config.routing.routingStream. */
  routingStreamEnabled?: boolean;
  /** Optional BR base URL override from config.routing.routingStreamUrl. */
  routingStreamUrl?: string;
  /**
   * Pre-built RoutingEventStream owned by the CLI boot code (Phase 2).
   * When provided, the dashboard reuses this connection instead of opening
   * a second one. The observer for learned-strategy updates is also attached
   * to this same stream at boot.
   */
  routingStream?: import("@brainst0rm/gateway").RoutingEventStream;
}

interface RoutingEntry {
  model: string;
  strategy: string;
  reason: string;
  timestamp: number;
}

interface ToolStat {
  name: string;
  calls: number;
  successes: number;
  lastDuration?: number;
}

export function App(props: AppProps) {
  const { exit } = useApp();
  const { mode, setMode, cycleMode, setModeByKey } = useMode("chat");
  const [sessionCost, setSessionCost] = useState(0);
  const [tokenCount, setTokenCount] = useState({ input: 0, output: 0 });
  const [currentModel, setCurrentModel] = useState<string | undefined>();
  const [currentRole, setCurrentRole] = useState<string | undefined>();
  const [isProcessing, setIsProcessing] = useState(false);
  const [routingHistory, setRoutingHistory] = useState<RoutingEntry[]>([]);
  const [toolStats, setToolStats] = useState<Map<string, ToolStat>>(new Map());
  const [turnCount, setTurnCount] = useState(0);
  const [sessionStart] = useState(Date.now());
  const { data: brData, refresh: refreshBR } = useBRData(props.gateway ?? null);
  const [lastCtrlD, setLastCtrlD] = useState(0);
  const [guardianStatus, setGuardianStatus] = useState<string | undefined>();
  const [showShortcuts, setShowShortcuts] = useState(false);
  const abortTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Global key handler for mode switching
  //
  // Pattern: Escape toggles between Chat and other modes.
  // In Chat: Escape (when idle) → Dashboard. Escape (when processing) → abort.
  // In other modes: Escape → Chat. Number keys 1-4 switch modes. Arrows navigate.
  useInput((input, key) => {
    if (key.escape) {
      if (mode === "chat") {
        // In chat: Escape while processing aborts; while idle opens dashboard
        if (isProcessing) {
          props.onAbort?.();
          if (abortTimeoutRef.current) clearTimeout(abortTimeoutRef.current);
          abortTimeoutRef.current = setTimeout(() => {
            setIsProcessing(false);
            abortTimeoutRef.current = null;
          }, 5000);
        } else {
          setMode("dashboard");
        }
      } else {
        // In any other mode: Escape returns to chat
        setMode("chat");
      }
      return;
    }

    // ? shows shortcut overlay (from any non-chat mode)
    if (input === "?" && mode !== "chat") {
      setShowShortcuts(true);
      return;
    }

    // In non-chat modes: number keys switch modes, Tab cycles, r refreshes
    if (mode !== "chat") {
      if (setModeByKey(input)) return;
      if (key.tab) {
        cycleMode();
        return;
      }
      if (input === "r" && mode === "dashboard") {
        refreshBR();
        return;
      }
    }

    // Ctrl+D: double-press within 2s to exit
    if (input === "d" && key.ctrl) {
      const now = Date.now();
      if (lastCtrlD > 0 && now - lastCtrlD < 2000) {
        exit();
      } else {
        setLastCtrlD(now);
      }
      return;
    }
  });

  const termHeight = process.stdout.rows || 24;

  // Wrap ChatApp's callbacks to capture shared state
  const wrappedSlashCallbacks = {
    ...props.slashCallbacks,
    gateway: props.gateway,
    setModel: (model: string) => {
      props.slashCallbacks?.setModel?.(model);
      const name = model.split("/").pop() ?? model;
      setCurrentModel(name);
    },
    setActiveRole: (role: string | undefined) => {
      props.slashCallbacks?.setActiveRole?.(role);
      setCurrentRole(role);
    },
  };

  // Wrap onSendMessage to capture cost/token updates
  function wrappedSendMessage(text: string): AsyncGenerator<AgentEvent> {
    const gen = props.onSendMessage(text);
    let lastRequestId: string | undefined;
    let lastModelUsed: string | undefined;

    return (async function* () {
      setIsProcessing(true);
      try {
        for await (const event of gen) {
          // Capture shared state from events
          if (event.type === "routing") {
            lastModelUsed =
              event.decision.model.id ?? event.decision.model.name;
            setCurrentModel(event.decision.model.name);
            setRoutingHistory((prev) => [
              {
                model: event.decision.model.name,
                strategy: event.decision.strategy,
                reason: event.decision.reason,
                timestamp: Date.now(),
              },
              ...prev.slice(0, 9),
            ]);
          }
          if (event.type === "tool-call-start") {
            setToolStats((prev) => {
              const next = new Map(prev);
              const existing = next.get(event.toolName) ?? {
                name: event.toolName,
                calls: 0,
                successes: 0,
              };
              next.set(event.toolName, {
                ...existing,
                calls: existing.calls + 1,
              });
              return next;
            });
          }
          if (event.type === "tool-call-result") {
            setToolStats((prev) => {
              const next = new Map(prev);
              const existing = next.get(event.toolName);
              if (existing) {
                next.set(event.toolName, {
                  ...existing,
                  successes: existing.successes + 1,
                });
              }
              return next;
            });
          }
          // Capture gateway feedback: request ID + live cost + guardian status
          if (event.type === "gateway-feedback") {
            lastRequestId = (event as any).feedback?.requestId;
            const actualCost = (event as any).feedback?.actualCost;
            if (typeof actualCost === "number" && actualCost > 0) {
              setSessionCost((prev) => Math.max(prev, actualCost));
            }
            const guardian = (event as any).feedback?.guardianStatus;
            if (guardian) setGuardianStatus(guardian);
          }
          if (event.type === "done") {
            setSessionCost(event.totalCost);
            if (event.totalTokens) setTokenCount(event.totalTokens);
            setTurnCount((prev) => prev + 1);
            // Auto-report outcome to BR for routing improvement
            if (props.gateway && lastRequestId) {
              props.gateway
                .reportOutcome(lastRequestId, {
                  success: true,
                  signals: {},
                  model_used: lastModelUsed,
                })
                .catch(() => {}); // fire-and-forget
            }
          }
          yield event;
        }
      } finally {
        setIsProcessing(false);
      }
    })();
  }

  return (
    <Box flexDirection="column" height={termHeight}>
      <ModeBar
        activeMode={mode}
        model={currentModel}
        cost={sessionCost}
        role={currentRole}
        guardianStatus={guardianStatus}
      />

      {/* ChatApp is always mounted to preserve conversation state.
          Hidden via display:none when other modes are active. */}
      <Box
        flexDirection="column"
        flexGrow={mode === "chat" ? 1 : 0}
        display={mode === "chat" ? "flex" : "none"}
      >
        <ChatApp
          strategy={props.strategy}
          modelCount={props.modelCount}
          onSendMessage={wrappedSendMessage}
          onAbort={props.onAbort}
          isActive={mode === "chat"}
          slashCallbacks={wrappedSlashCallbacks}
        />
      </Box>

      {mode === "dashboard" && (
        <DashboardMode
          sessionCost={sessionCost}
          tokenCount={tokenCount}
          modelCount={props.modelCount}
          routingHistory={routingHistory}
          toolStats={Array.from(toolStats.values())}
          turnCount={turnCount}
          sessionStart={sessionStart}
          brData={brData}
          onRefreshBR={refreshBR}
          godModeInfo={props.godModeInfo}
          routingStreamEnabled={props.routingStreamEnabled}
          routingStreamUrl={props.routingStreamUrl}
          routingStream={props.routingStream}
        />
      )}

      {mode === "models" && (
        <ModelsMode
          models={props.models ?? []}
          currentModelId={currentModel}
          onSelectModel={(id) => {
            props.slashCallbacks?.setModel?.(id);
            const name = id.split("/").pop() ?? id;
            setCurrentModel(name);
            setMode("chat");
          }}
        />
      )}

      {mode === "config" && (
        <ConfigMode
          strategy={props.configInfo?.strategy ?? props.strategy}
          permissionMode={props.configInfo?.permissionMode ?? "confirm"}
          outputStyle={props.configInfo?.outputStyle ?? "concise"}
          sandbox={props.configInfo?.sandbox ?? "none"}
          role={currentRole}
          modelCount={props.modelCount}
          turnCount={turnCount}
          sessionCost={sessionCost}
          vaultInfo={props.vaultInfo}
          memoryInfo={props.memoryInfo}
        />
      )}

      {mode === "planning" && <PlanningMode />}

      <KeyHint mode={mode} isProcessing={isProcessing} />

      {/* Shortcut overlay */}
      {showShortcuts && (
        <ShortcutOverlay onDismiss={() => setShowShortcuts(false)} />
      )}
    </Box>
  );
}
