/**
 * Business · Inspect verb body. Read-only diagnostics: cold-open verify
 * pills, AI-loop event stream, customers intent↔runtime drift list. Apply
 * actions live in the Operate body.
 */
import { useEffect, useState } from "react";
import type { BusinessToml } from "@brainst0rm/config";
import {
  BusinessBodyHeader,
  BusinessBodyShell,
  DriftRow,
  InlineEmpty,
  LoopEventLog,
  SessionVerifyPills,
  sectionTitleStyle,
  useCustomerDrift,
} from "./BusinessHarnessShared";
import type { HarnessSessionVerify } from "../../lib/harness-types";
import type { HarnessLoopEvent } from "../../global";

interface BusinessInspectBodyProps {
  root: string;
  manifest: BusinessToml;
  sessionVerify: HarnessSessionVerify | null;
}

export function BusinessInspectBody({
  root,
  manifest,
  sessionVerify,
}: BusinessInspectBodyProps) {
  const [loopEvents, setLoopEvents] = useState<HarnessLoopEvent[]>([]);

  useEffect(() => {
    const bridge = window.brainstorm;
    if (!bridge) return;
    let mounted = true;
    bridge
      .recentHarnessLoopEvents(20)
      .then((events) => {
        if (mounted) setLoopEvents(events);
      })
      .catch(() => {});
    const unsub = bridge.onHarnessLoopEvent((event) => {
      if (!mounted) return;
      setLoopEvents((prev) => {
        // Suppress no-op renders when an identical event is delivered
        // twice (rare but possible across IPC boundaries).
        const last = prev[prev.length - 1];
        if (last && last.at === event.at && last.loop === event.loop) {
          return prev;
        }
        return [...prev.slice(-29), event];
      });
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  return (
    <BusinessBodyShell>
      <BusinessBodyHeader
        verb="Inspect"
        archetype={manifest.identity.archetype}
        name={manifest.identity.name}
        root={root}
      />

      <section style={{ marginBottom: 32 }}>
        <h2 style={sectionTitleStyle}>Index Session</h2>
        <SessionVerifyPills sessionVerify={sessionVerify} />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={sectionTitleStyle}>AI Loops</h2>
        <LoopEventLog events={loopEvents} />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={sectionTitleStyle}>Customers · Drift Detection</h2>
        <CustomersDriftPanel />
      </section>
    </BusinessBodyShell>
  );
}

function CustomersDriftPanel() {
  const { drifts, unobserved, loading, error } = useCustomerDrift();

  return (
    <div
      style={{
        padding: 16,
        background: "var(--ctp-surface0)",
        borderRadius: 12,
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: 600,
          color: "var(--ctp-overlay1)",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          marginBottom: 10,
        }}
      >
        Intent ↔ Runtime Drift
      </div>

      {loading && (
        <div
          style={{ fontSize: "var(--text-xs)", color: "var(--ctp-overlay0)" }}
        >
          Running detector…
        </div>
      )}

      {error && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ctp-red)" }}>
          {error}
        </div>
      )}

      {!loading && !error && drifts.length === 0 && unobserved.length === 0 && (
        <InlineEmpty text="No drift detected. (No accounts under customers/accounts/.)" />
      )}

      {drifts.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            marginBottom: 12,
          }}
        >
          {drifts.map((d) => (
            <DriftRow key={d.id} drift={d} />
          ))}
          <div
            style={{
              marginTop: 6,
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
              fontStyle: "italic",
            }}
          >
            To resolve, switch to the Operate verb and apply intent → runtime.
          </div>
        </div>
      )}

      {unobserved.length > 0 && (
        <div
          style={{
            padding: 10,
            background: "var(--ctp-mantle)",
            borderRadius: 6,
            border: "1px solid var(--border-subtle)",
            fontSize: "var(--text-xs)",
            color: "var(--ctp-subtext1)",
          }}
        >
          <div
            style={{
              fontWeight: 500,
              color: "var(--ctp-text)",
              marginBottom: 4,
            }}
          >
            {unobserved.length} account{unobserved.length === 1 ? "" : "s"}{" "}
            without runtime observation
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay1)",
            }}
          >
            {unobserved.slice(0, 5).join(", ")}
            {unobserved.length > 5 && ` …+${unobserved.length - 5} more`}
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
            }}
          >
            Wire a runtime poller (Stripe, MSP, etc.) to drop runtime.toml
            siblings; drift detection activates automatically.
          </div>
        </div>
      )}
    </div>
  );
}
