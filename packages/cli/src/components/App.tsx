/**
 * Top-level App — Mode switcher for the multi-pane TUI.
 *
 * Renders ModeBar + active mode content + KeyHint.
 * Mode 1 (Chat) delegates to ChatApp. Other modes are dashboard views.
 */

import React, { useState } from "react";
import { Box, useApp, useInput } from "ink";
import { useMode, type TUIMode } from "../hooks/useMode.js";
import { ModeBar } from "./ModeBar.js";
import { KeyHint } from "./KeyHint.js";
import { ChatApp } from "./ChatApp.js";
import { DashboardMode } from "./modes/DashboardMode.js";
import { ModelsMode } from "./modes/ModelsMode.js";
import { ConfigMode } from "./modes/ConfigMode.js";
import type { AgentEvent, AgentTask } from "@brainstorm/shared";

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

  // Global key handler for mode switching
  useInput((input, key) => {
    // Escape returns to chat from any non-chat mode
    if (key.escape && mode !== "chat") {
      setMode("chat");
      return;
    }

    // In non-chat modes: plain number keys switch modes
    if (mode !== "chat") {
      if (setModeByKey(input)) return;
    }

    // In chat mode: Ctrl+number switches modes (doesn't conflict with text input)
    if (mode === "chat" && key.ctrl) {
      if (setModeByKey(input)) return;
    }

    // Tab cycles modes (only from non-chat modes to avoid conflict with input)
    if (key.tab && !key.shift && mode !== "chat") {
      cycleMode();
      return;
    }

    // Ctrl+D exits
    if (input === "d" && key.ctrl) {
      exit();
      return;
    }
  });

  const termHeight = process.stdout.rows || 24;

  // Wrap ChatApp's callbacks to capture shared state
  const wrappedSlashCallbacks = {
    ...props.slashCallbacks,
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
    setIsProcessing(true);
    const gen = props.onSendMessage(text);

    return (async function* () {
      try {
        for await (const event of gen) {
          // Capture shared state from events
          if (event.type === "routing") {
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
          if (event.type === "done") {
            setSessionCost(event.totalCost);
            if (event.totalTokens) setTokenCount(event.totalTokens);
            setTurnCount((prev) => prev + 1);
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
        />
      )}

      {mode === "models" && (
        <ModelsMode
          models={props.models ?? []}
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
        />
      )}

      <KeyHint mode={mode} isProcessing={isProcessing} />
    </Box>
  );
}
