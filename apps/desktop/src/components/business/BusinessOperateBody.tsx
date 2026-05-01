/**
 * Business · Operate verb body.
 *
 * Action surface: a focused open-drifts list with apply buttons (one
 * `DriftRow` per drift, shared with the legacy CustomersDriftPanel) and
 * a placeholder "Run indexer loop now" card whose button is wired in
 * Group E (`runHarnessLoopOnce` IPC).
 *
 * Diagnostics (drift detection, unobserved accounts, AI-loop log) live
 * under the Inspect verb body. This body intentionally re-runs
 * `detectCustomerDrift` so it always shows the latest open drifts at
 * verb-switch time.
 */
import { useEffect, useState } from "react";
import type { BusinessToml } from "@brainst0rm/config";
import {
  DriftRow,
  sectionTitleStyle,
  type CustomerDrift,
} from "./BusinessHarnessShared";
import type { HarnessSessionVerify } from "../../lib/harness-types";

interface BusinessOperateBodyProps {
  root: string;
  manifest: BusinessToml;
  /** Currently unused at the body level — reserved for future "Run loop"
   * messages tagged with the cold-open verify state. */
  sessionVerify: HarnessSessionVerify | null;
}

export function BusinessOperateBody({
  root,
  manifest,
  sessionVerify: _sessionVerify,
}: BusinessOperateBodyProps) {
  const [drifts, setDrifts] = useState<CustomerDrift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.brainstorm;
    if (!bridge) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    bridge
      .detectCustomerDrift()
      .then((res) => {
        setDrifts(res.drifts);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
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
            Operate · {manifest.identity.name}
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

        {/* Run loop now — wired in Group E */}
        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionTitleStyle}>Run AI Loops</h2>
          <div
            style={{
              padding: 16,
              background: "var(--ctp-surface0)",
              borderRadius: 12,
              border: "1px solid var(--border-subtle)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
            }}
          >
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ctp-subtext1)",
                lineHeight: 1.5,
              }}
            >
              Trigger the indexer loop on demand instead of waiting for the
              schedule. Useful after editing files outside the desktop app.
            </div>
            <button
              disabled
              className="interactive"
              title="Wired in Group E"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ctp-overlay1)",
                background: "var(--ctp-surface1)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 6,
                padding: "8px 14px",
                cursor: "not-allowed",
                opacity: 0.6,
                whiteSpace: "nowrap",
              }}
            >
              Run indexer loop now (wired in Group E)
            </button>
          </div>
        </section>

        {/* Open drifts — apply buttons */}
        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionTitleStyle}>
            Open Drifts
            {!loading && (
              <span
                style={{
                  marginLeft: 10,
                  fontWeight: 400,
                  color: "var(--ctp-overlay1)",
                  textTransform: "none",
                  letterSpacing: 0,
                }}
              >
                ({drifts.length})
              </span>
            )}
          </h2>

          {loading && (
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
              Running detector…
            </div>
          )}

          {error && (
            <div
              style={{
                padding: 14,
                background: "var(--ctp-mantle)",
                borderRadius: 8,
                border: "1px solid var(--ctp-red)",
                fontSize: "var(--text-xs)",
                color: "var(--ctp-red)",
              }}
            >
              {error}
            </div>
          )}

          {!loading && !error && drifts.length === 0 && (
            <div
              style={{
                padding: 14,
                background: "var(--ctp-mantle)",
                borderRadius: 8,
                border: "1px solid var(--border-subtle)",
                fontSize: "var(--text-xs)",
                color: "var(--ctp-overlay1)",
                fontStyle: "italic",
              }}
            >
              No open drifts. Customer intent matches runtime observation.
            </div>
          )}

          {drifts.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {drifts.map((d) => (
                <DriftRow
                  key={d.id}
                  drift={d}
                  onApplied={(id) =>
                    setDrifts((prev) => prev.filter((x) => x.id !== id))
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
