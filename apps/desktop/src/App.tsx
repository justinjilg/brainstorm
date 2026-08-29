/**
 * App — the thin outer frame: boot gate, title bar, fatal/health banners, and
 * the flagship shell. The former 826-line god-object (5×5 entity×verb grid,
 * AppMode shim, five Workspaces) is gone; all navigation and state now live in
 * AppShell and the places/ modules.
 */
import { useEffect, useState } from "react";
import { AppShell } from "./components/shell/AppShell";
import { BootSplash } from "./components/BootSplash";
import { useBackendReady } from "./hooks/useBackendReady";
import { useServerHealth } from "./hooks/useServerHealth";
import { useOrganism } from "./hooks/useOrganism";
import { useToast } from "./components/Toast";

export function App() {
  const backendReady = useBackendReady();
  const serverHealth = useServerHealth();
  const { state, connected } = useOrganism();
  const [fatalError, setFatalError] = useState<string | null>(null);
  const toast = useToast();

  // Fatal backend errors + auto-update notifications ride the shared event
  // channel; everything else the UI needs comes off the organism bus.
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

  if (!backendReady) return <BootSplash />;

  const halted =
    state.kairos.status === "halted" ||
    state.kairos.status === "stopped" ||
    state.kairos.status === "paused";

  return (
    <div
      className="flex flex-col h-screen"
      style={{ background: "var(--ctp-crust)" }}
      data-testid="app-root"
    >
      {/* Title bar — a menubar-style live tick keeps the organism glowing at the
          very edge even before Pulse is opened. */}
      <div
        className="h-9 flex items-center justify-between shrink-0"
        style={{
          background: "var(--ctp-mantle)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <div className="w-28 shrink-0" />
        <span
          className="select-none tracking-[0.15em] uppercase"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ctp-overlay0)" }}
        >
          Brainstorm
        </span>
        <div className="w-28 shrink-0 flex items-center justify-end pr-4 gap-2 font-mono tabular-nums">
          <span
            title={connected ? `KAIROS ${state.kairos.status}` : "Connecting…"}
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay1)",
            }}
          >
            {connected ? `⟡ ${state.kairos.tickCount}` : "⟡ —"}
          </span>
          <span
            className={!halted && connected ? "animate-breathe" : ""}
            title={serverHealth.connected ? "Connected" : "Disconnected"}
            style={{
              width: 8,
              height: 8,
              borderRadius: "9999px",
              background: halted ? "var(--sig-warn)" : "var(--organism)",
              boxShadow: `0 0 8px ${halted ? "var(--sig-warn)" : "var(--organism)"}`,
            }}
          />
        </div>
      </div>

      {fatalError && (
        <div
          data-testid="fatal-error"
          className="px-4 py-3 shrink-0"
          style={{
            background: "rgba(243, 139, 168, 0.15)",
            borderBottom: "2px solid var(--ctp-red)",
            fontSize: "var(--text-sm)",
            color: "var(--ctp-red)",
          }}
        >
          {fatalError}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <AppShell />
      </div>
    </div>
  );
}
