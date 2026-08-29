/**
 * Top-level TUI — "The Glance".
 *
 * The demoted terminal surface (its charter in the UX reimagining): one Chat +
 * one StatusStrip off the shared event stream, and nothing else. The former
 * 4-pane switcher (Dashboard/Models/Config/Planning + its top bar and switcher
 * state) is gone — there is deliberately NO pane-switching seam to hang a new
 * view on. The rich, live surfaces live in the desktop flagship (the Vivarium).
 *
 * ChatApp already renders the StatusBar (model / cost / tokens / strategy), so
 * this component is just: wrap the message stream to capture cost + report the
 * turn outcome to BR (the learning-loop invariant), and mount ChatApp.
 */

import React, { useState } from "react";
import { Box, useApp, useInput } from "ink";
import { ChatApp } from "./ChatApp.js";
import type { AgentEvent } from "@brainst0rm/shared";

interface AppProps {
  strategy: string;
  modelCount: { local: number; cloud: number };
  onSendMessage: (text: string) => AsyncGenerator<AgentEvent>;
  onAbort?: () => void;
  slashCallbacks?: any;
  /** BrainstormRouter gateway client — used only to report turn outcomes. */
  gateway?: import("@brainst0rm/gateway").BrainstormGateway;
  // The following props were consumed by the deleted dashboard modes. They are
  // accepted (so existing callers keep compiling) but intentionally unused —
  // this surface no longer renders them. They belong to the desktop flagship.
  models?: unknown;
  configInfo?: unknown;
  vaultInfo?: unknown;
  memoryInfo?: unknown;
  godModeInfo?: unknown;
  routingStreamEnabled?: boolean;
  routingStreamUrl?: string;
  routingStream?: import("@brainst0rm/gateway").RoutingEventStream;
}

export function App(props: AppProps) {
  const { exit } = useApp();
  const [currentModel, setCurrentModel] = useState<string | undefined>();
  const [currentRole, setCurrentRole] = useState<string | undefined>();
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastCtrlD, setLastCtrlD] = useState(0);

  // Ctrl+D twice within 2s exits; Esc while processing aborts. No mode keys.
  useInput((input, key) => {
    if (key.escape && isProcessing) {
      props.onAbort?.();
      return;
    }
    if (input === "d" && key.ctrl) {
      const now = Date.now();
      if (lastCtrlD > 0 && now - lastCtrlD < 2000) exit();
      else setLastCtrlD(now);
    }
  });

  const termHeight = process.stdout.rows || 24;

  const wrappedSlashCallbacks = {
    ...props.slashCallbacks,
    gateway: props.gateway,
    setModel: (model: string) => {
      props.slashCallbacks?.setModel?.(model);
      setCurrentModel(model.split("/").pop() ?? model);
    },
    setActiveRole: (role: string | undefined) => {
      props.slashCallbacks?.setActiveRole?.(role);
      setCurrentRole(role);
    },
  };

  // Wrap the message stream to capture the turn outcome and report it to BR.
  // The label must be lifecycle-derived (never a constant) — BR's routing
  // posterior trains on it (the learning-loop invariant).
  function wrappedSendMessage(text: string): AsyncGenerator<AgentEvent> {
    const gen = props.onSendMessage(text);
    let lastRequestId: string | undefined;
    let lastModelUsed: string | undefined;
    let turnError: string | undefined;
    let turnCost: number | undefined;
    let verifyCompiled: boolean | undefined;
    let verifyTestsPassed: boolean | undefined;
    let sawDone = false;

    return (async function* () {
      setIsProcessing(true);
      try {
        for await (const event of gen) {
          if (event.type === "routing") {
            lastModelUsed =
              event.decision.model.id ?? event.decision.model.name;
            setCurrentModel(event.decision.model.name);
          }
          if (event.type === "gateway-feedback") {
            lastRequestId = (event as any).feedback?.requestId;
          }
          if (event.type === "error") {
            const raw = (event as { error?: unknown }).error;
            turnError =
              raw instanceof Error ? raw.message : raw ? String(raw) : "error";
          }
          if (event.type === "fallback-exhausted") {
            turnError = `fallback exhausted: ${event.reason}`;
          }
          if (event.type === "verify-passed") {
            verifyCompiled = true;
            if (event.mode === "full") verifyTestsPassed = true;
          }
          if (event.type === "verify-failed") {
            verifyCompiled = false;
          }
          if (event.type === "done") {
            sawDone = true;
            turnCost = event.totalCost;
          }
          yield event;
        }
      } finally {
        if (props.gateway && lastRequestId) {
          props.gateway
            .reportOutcome(lastRequestId, {
              success: sawDone && !turnError && verifyCompiled !== false,
              error: turnError,
              modelUsed: lastModelUsed,
              cost: turnCost,
              codeCompiled: verifyCompiled,
              testsPassed: verifyTestsPassed,
            })
            .catch(() => {});
        }
        setIsProcessing(false);
      }
    })();
  }

  // currentRole is captured for the slash callbacks; referenced here to keep the
  // wiring explicit even though StatusBar (inside ChatApp) owns its display.
  void currentRole;
  void currentModel;

  return (
    <Box flexDirection="column" height={termHeight}>
      <ChatApp
        strategy={props.strategy}
        modelCount={props.modelCount}
        onSendMessage={wrappedSendMessage}
        onAbort={props.onAbort}
        isActive={true}
        slashCallbacks={wrappedSlashCallbacks}
      />
    </Box>
  );
}
