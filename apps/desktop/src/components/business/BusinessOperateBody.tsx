/**
 * Business · Operate verb body. Action surface for harness operations:
 * apply intent→runtime ChangeSets per open drift, and run AI loops on
 * demand.
 */
import { useState } from "react";
import type { BusinessToml } from "@brainst0rm/config";
import type { HarnessLoopEvent } from "../../global";
import {
  BusinessBodyHeader,
  BusinessBodyShell,
  DriftRow,
  InlineEmpty,
  sectionTitleStyle,
  useCustomerDrift,
} from "./BusinessHarnessShared";

interface BusinessOperateBodyProps {
  root: string;
  manifest: BusinessToml;
}

type LoopRunResult = HarnessLoopEvent | { ok: false; error: string };

export function BusinessOperateBody({
  root,
  manifest,
}: BusinessOperateBodyProps) {
  const { drifts, loading, error, removeDrift } = useCustomerDrift();
  const [loopPending, setLoopPending] = useState(false);
  const [loopResult, setLoopResult] = useState<LoopRunResult | null>(null);

  const runIndexerLoop = async () => {
    const bridge = window.brainstorm;
    if (!bridge?.runHarnessLoopOnce) return;
    setLoopPending(true);
    setLoopResult(null);
    try {
      const result = await bridge.runHarnessLoopOnce("indexer");
      setLoopResult(result);
    } catch (err) {
      setLoopResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoopPending(false);
    }
  };

  const isBridgeError = (r: LoopRunResult): r is { ok: false; error: string } =>
    "ok" in r && r.ok === false;
  const loopFailed =
    loopResult !== null &&
    (isBridgeError(loopResult) || loopResult.status === "failed");
  const loopStatusLabel = loopResult
    ? isBridgeError(loopResult)
      ? "failed"
      : loopResult.status
    : "";
  const loopDetail = loopResult
    ? isBridgeError(loopResult)
      ? loopResult.error
      : (loopResult.error ??
        (loopResult.summary
          ? JSON.stringify(loopResult.summary)
          : "(no summary)"))
    : "";

  return (
    <BusinessBodyShell>
      <BusinessBodyHeader
        verb="Operate"
        archetype={manifest.identity.archetype}
        name={manifest.identity.name}
        root={root}
      />

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
            onClick={runIndexerLoop}
            disabled={loopPending}
            className="interactive"
            style={{
              fontSize: "var(--text-xs)",
              color: loopPending ? "var(--ctp-overlay1)" : "var(--ctp-text)",
              background: "var(--ctp-surface1)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              padding: "8px 14px",
              cursor: loopPending ? "wait" : "pointer",
              opacity: loopPending ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {loopPending ? "Running…" : "Run indexer loop now"}
          </button>
        </div>
        {loopResult !== null && (
          <div
            style={{
              marginTop: 8,
              padding: "8px 12px",
              background: "var(--ctp-mantle)",
              borderRadius: 8,
              border: `1px solid ${loopFailed ? "var(--ctp-red)" : "var(--border-subtle)"}`,
              fontSize: "var(--text-2xs)",
              color: loopFailed ? "var(--ctp-red)" : "var(--ctp-subtext1)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--ctp-overlay1)",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              indexer
            </span>
            <span style={{ fontWeight: 600 }}>{loopStatusLabel}</span>
            <span style={{ color: "var(--ctp-overlay1)" }}>{loopDetail}</span>
          </div>
        )}
      </section>

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

        {loading && <InlineEmpty text="Running detector…" />}

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
          <InlineEmpty text="No open drifts. Customer intent matches runtime observation." />
        )}

        {drifts.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {drifts.map((d) => (
              <DriftRow key={d.id} drift={d} onApplied={removeDrift} />
            ))}
          </div>
        )}
      </section>
    </BusinessBodyShell>
  );
}
