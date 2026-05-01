/**
 * Business · Inspect verb body.
 *
 * Read-only diagnostics for an open harness:
 *   - Cold-open verify summary pills (clean / stale / missing / unindexed)
 *   - AI-loop live event stream
 *   - Customers intent↔runtime drift panel (read-only here — apply
 *     buttons live in the Operate verb body)
 *
 * Pulls the same `detectCustomerDrift` IPC the Operate body uses; cheap
 * call so duplicating across verbs is fine for Phase 1.
 */
import { useEffect, useState } from "react";
import type { BusinessToml } from "@brainst0rm/config";
import {
  DriftStatPill,
  LoopEventLog,
  sectionTitleStyle,
  type CustomerDrift,
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
      setLoopEvents((prev) => [...prev.slice(-29), event]);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  return (
    <div
      className="flex-1 overflow-y-auto"
      style={{
        background: "var(--ctp-base)",
        color: "var(--ctp-text)",
        padding: "32px",
      }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <header style={{ marginBottom: 32 }}>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Inspect · {manifest.identity.name}
          </div>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ctp-overlay0)",
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            {root}
          </div>
        </header>

        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionTitleStyle}>Index Session</h2>
          {sessionVerify === null ? (
            <div
              style={{
                padding: 14,
                background: "var(--ctp-mantle)",
                borderRadius: 8,
                border: "1px solid var(--border-subtle)",
                fontSize: "var(--text-xs)",
                color: "var(--ctp-overlay1)",
              }}
            >
              Opening index session…
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: 8,
              }}
            >
              <DriftStatPill
                label="clean"
                value={sessionVerify.clean}
                color="var(--ctp-green)"
              />
              <DriftStatPill
                label="stale"
                value={sessionVerify.stale.length}
                color={
                  sessionVerify.stale.length > 0
                    ? "var(--ctp-yellow)"
                    : undefined
                }
              />
              <DriftStatPill
                label="missing"
                value={sessionVerify.missing.length}
                color={
                  sessionVerify.missing.length > 0
                    ? "var(--ctp-red)"
                    : undefined
                }
              />
              <DriftStatPill
                label="unindexed"
                value={sessionVerify.unindexedCount}
              />
            </div>
          )}
        </section>

        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionTitleStyle}>AI Loops</h2>
          <LoopEventLog events={loopEvents} />
        </section>

        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionTitleStyle}>Customers · Drift Detection</h2>
          <CustomersDriftPanel />
        </section>
      </div>
    </div>
  );
}

/**
 * Read-only customers drift surface — same `detectCustomerDrift` IPC
 * the Operate body uses, but renders only the drift list (no apply
 * button) and the unobserved-accounts hint. Apply lives in Operate.
 */
function CustomersDriftPanel() {
  const [drifts, setDrifts] = useState<CustomerDrift[]>([]);
  const [unobserved, setUnobserved] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.brainstorm;
    if (!bridge) {
      setLoading(false);
      return;
    }
    bridge
      .detectCustomerDrift()
      .then((res) => {
        setDrifts(res.drifts);
        setUnobserved(res.unobserved_accounts);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, []);

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
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ctp-overlay1)",
            fontStyle: "italic",
          }}
        >
          No drift detected. (No accounts under customers/accounts/.)
        </div>
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
            <ReadOnlyDriftRow key={d.id} drift={d} />
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

function ReadOnlyDriftRow({ drift }: { drift: CustomerDrift }) {
  const severityColor =
    drift.severity === "critical"
      ? "var(--ctp-red)"
      : drift.severity === "high"
        ? "var(--ctp-yellow)"
        : "var(--ctp-overlay1)";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 100px 1fr 1fr",
        gap: 12,
        alignItems: "baseline",
        padding: "8px 12px",
        background: "var(--ctp-mantle)",
        borderRadius: 6,
        border: `1px solid ${severityColor}`,
        borderLeftWidth: 3,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "var(--text-xs)",
          color: "var(--ctp-text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={drift.relative_path}
      >
        {drift.relative_path}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-subtext1)",
        }}
      >
        {drift.field_path}
      </div>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ctp-text)",
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        intent: {drift.intent_value ?? "—"}
      </div>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: severityColor,
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        observed: {drift.observed_value ?? "—"}
      </div>
    </div>
  );
}
