/**
 * Business · Operate verb body. Action surface for harness operations:
 * apply intent→runtime ChangeSets per open drift, and run AI loops on
 * demand.
 */
import type { BusinessToml } from "@brainst0rm/config";
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

export function BusinessOperateBody({
  root,
  manifest,
}: BusinessOperateBodyProps) {
  const { drifts, loading, error, removeDrift } = useCustomerDrift();

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
          {/* Group E lands the wiring; the placeholder ships disabled
              rather than absent so the layout doesn't shift on activation. */}
          <button
            disabled
            className="interactive"
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
            Run indexer loop now
          </button>
        </div>
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
