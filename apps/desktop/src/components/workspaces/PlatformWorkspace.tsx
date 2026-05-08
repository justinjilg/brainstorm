/**
 * Platform workspace.
 *
 * Phase 1: mounts the existing cross-cutting views (Workflows, Dashboard,
 * KAIROS controls, Models, Security, Config) under the appropriate verb.
 * Configure has multiple legitimate sub-views (Models / Security / Config)
 * so it carries an inline sub-tab strip.
 */
import { useState } from "react";
import { Placeholder } from "./Placeholder";
import { WorkflowsView } from "../workflows/WorkflowsView";
import {
  DashboardView,
  type RoutingDecision,
} from "../dashboard/DashboardView";
import { ModelsView } from "../models/ModelsView";
import { SecurityView } from "../security/SecurityView";
import { ConfigView } from "../config/ConfigView";
import { ErrorBoundary } from "../ErrorBoundary";
import type { VerbKind } from "../../lib/workspace";

type KairosStatus = "running" | "sleeping" | "paused" | "stopped";
type ConfigureTab = "models" | "security" | "config";

interface PlatformWorkspaceProps {
  verb: VerbKind;
  sessionCost: number;
  routingDecisions: RoutingDecision[];
  kairosStatus: KairosStatus;
  onKairosStart: () => void;
  onKairosStop: () => void;
  onModelSelect: (id: string, name: string, provider: string) => void;
}

export function PlatformWorkspace({
  verb,
  sessionCost,
  routingDecisions,
  kairosStatus,
  onKairosStart,
  onKairosStop,
  onModelSelect,
}: PlatformWorkspaceProps) {
  const [configureTab, setConfigureTab] = useState<ConfigureTab>("models");

  switch (verb) {
    case "plan":
      return (
        <ErrorBoundary fallbackLabel="Workflows">
          <WorkflowsView />
        </ErrorBoundary>
      );
    case "inspect":
      return (
        <ErrorBoundary fallbackLabel="Dashboard">
          <DashboardView
            sessionCost={sessionCost}
            routingDecisions={routingDecisions}
          />
        </ErrorBoundary>
      );
    case "operate":
      return (
        <KairosPanel
          status={kairosStatus}
          onStart={onKairosStart}
          onStop={onKairosStop}
        />
      );
    case "configure":
      return (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            background: "var(--ctp-base)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 0,
              borderBottom: "1px solid var(--border-subtle)",
              background: "var(--ctp-mantle)",
              flexShrink: 0,
            }}
          >
            {(["models", "security", "config"] as ConfigureTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setConfigureTab(t)}
                className="interactive"
                style={{
                  padding: "8px 14px",
                  fontSize: "var(--text-2xs)",
                  fontWeight: configureTab === t ? 600 : 500,
                  color:
                    configureTab === t
                      ? "var(--ctp-text)"
                      : "var(--ctp-overlay1)",
                  background: "transparent",
                  border: "none",
                  borderBottom: `2px solid ${
                    configureTab === t ? "var(--ctp-blue)" : "transparent"
                  }`,
                  cursor: "pointer",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {configureTab === "models" && (
              <ErrorBoundary fallbackLabel="Models">
                <ModelsView onModelSelect={onModelSelect} />
              </ErrorBoundary>
            )}
            {configureTab === "security" && (
              <ErrorBoundary fallbackLabel="Security">
                <SecurityView />
              </ErrorBoundary>
            )}
            {configureTab === "config" && (
              <ErrorBoundary fallbackLabel="Config">
                <ConfigView />
              </ErrorBoundary>
            )}
          </div>
        </div>
      );
    default:
      return null;
  }
}

function KairosPanel({
  status,
  onStart,
  onStop,
}: {
  status: KairosStatus;
  onStart: () => void;
  onStop: () => void;
}) {
  const STATUS_LABEL: Record<KairosStatus, { label: string; color: string }> = {
    running: { label: "Running", color: "var(--ctp-green)" },
    sleeping: { label: "Sleeping", color: "var(--ctp-blue)" },
    paused: { label: "Paused", color: "var(--ctp-yellow)" },
    stopped: { label: "Stopped", color: "var(--ctp-overlay0)" },
  };
  const info = STATUS_LABEL[status];
  const isLive = status === "running" || status === "sleeping";
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 24,
        padding: 32,
        background: "var(--ctp-base)",
        overflow: "auto",
      }}
    >
      <div>
        <div
          style={{
            fontSize: "var(--text-2xs)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--ctp-overlay0)",
            marginBottom: 8,
          }}
        >
          Platform · Operate
        </div>
        <h1
          style={{
            fontSize: "var(--text-2xl, 22px)",
            fontWeight: 600,
            color: "var(--ctp-text)",
            margin: 0,
          }}
        >
          KAIROS
        </h1>
      </div>
      <div
        style={{
          padding: 20,
          background: "var(--ctp-mantle)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            Status
          </div>
          <div
            style={{
              fontSize: "var(--text-lg, 18px)",
              fontWeight: 600,
              color: info.color,
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            {info.label}
          </div>
        </div>
        <button
          onClick={isLive ? onStop : onStart}
          className="interactive"
          style={{
            padding: "10px 20px",
            fontSize: "var(--text-sm)",
            fontWeight: 600,
            color: "var(--ctp-base)",
            background: isLive ? "var(--ctp-red)" : "var(--ctp-green)",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          {isLive ? "Stop" : "Start"}
        </button>
      </div>
      <Placeholder
        title="Connector invoke · Scheduler queue"
        description="Remaining Operate surfaces (run a God Mode connector, peek the scheduler queue, force model rotation) land in Phase 2."
      />
    </div>
  );
}
