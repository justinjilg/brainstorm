/**
 * BusinessHarnessView — placeholder view for the business harness.
 *
 * v1 scope per the spec at ~/.claude/plans/snuggly-sleeping-hinton.md:
 *   - Render the parsed manifest contents (identity, archetype, products,
 *     runtimes, external systems, AI-loop budget, validation tiers).
 *   - Show the seven universal folders as a navigation list.
 *   - Display a clear "no panels yet" notice — full Environment View
 *     panels are deferred to subsequent build phases per the
 *     implementation order in `## Index Coherence and Drift Architecture`.
 *
 * This is intentionally minimal — proves the wiring works (manifest parses,
 * IPC delivers it, React renders it) before any panel design lands.
 */

import type { BusinessToml } from "@brainst0rm/config";
import type { HarnessSessionVerify } from "../../lib/harness-types";

interface BusinessHarnessViewProps {
  root: string;
  manifest: BusinessToml;
  /** Cold-open verification result. null while pending or unavailable. */
  sessionVerify: HarnessSessionVerify | null;
  onClose: () => void;
}

const SEVEN_FOLDERS: Array<{ slug: string; label: string; why: string }> = [
  { slug: "identity", label: "Identity", why: "Mission, brand, principles" },
  { slug: "team", label: "Team", why: "Humans + agents" },
  { slug: "customers", label: "Customers", why: "Who we serve" },
  { slug: "products", label: "Products", why: "What we make/sell" },
  {
    slug: "operations",
    label: "Operations",
    why: "IT, security, finance, legal, HR-ops",
  },
  { slug: "market", label: "Market", why: "GTM, marketing, sales, community" },
  {
    slug: "governance",
    label: "Governance",
    why: "Contracts, compliance, decisions",
  },
];

export function BusinessHarnessView({
  root,
  manifest,
  sessionVerify,
  onClose,
}: BusinessHarnessViewProps) {
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
        {/* Header — identity */}
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: 32,
          }}
        >
          <div>
            <div
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Business Harness · {manifest.identity.archetype}
            </div>
            <h1
              style={{
                fontSize: "var(--text-3xl, 28px)",
                fontWeight: 600,
                color: "var(--ctp-text)",
                margin: 0,
              }}
            >
              {manifest.identity.name}
            </h1>
            {manifest.identity.legal_name &&
              manifest.identity.legal_name !== manifest.identity.name && (
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--ctp-subtext1)",
                    marginTop: 4,
                  }}
                >
                  {manifest.identity.legal_name}
                </div>
              )}
            <div
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ctp-overlay0)",
                marginTop: 8,
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              {root}
            </div>
          </div>
          <button
            onClick={onClose}
            className="interactive"
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ctp-overlay1)",
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid var(--border-subtle)",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </header>

        {/* Index session — drift summary from cold-open verify */}
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

        {/* Seven universal folders */}
        <section style={{ marginBottom: 40 }}>
          <h2 style={sectionTitleStyle}>Seven Universal Folders</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            {SEVEN_FOLDERS.map((folder) => (
              <div
                key={folder.slug}
                style={{
                  padding: 16,
                  background: "var(--ctp-surface0)",
                  borderRadius: 12,
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "var(--text-2xs)",
                    color: "var(--ctp-overlay0)",
                    marginBottom: 4,
                  }}
                >
                  {folder.slug}/
                </div>
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: 500,
                    color: "var(--ctp-text)",
                    marginBottom: 4,
                  }}
                >
                  {folder.label}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ctp-subtext1)",
                  }}
                >
                  {folder.why}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Federation pointers */}
        {manifest.products.length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={sectionTitleStyle}>
              Products ({manifest.products.length})
            </h2>
            <div style={listStyle}>
              {manifest.products.map((p) => (
                <PointerRow
                  key={p.slug}
                  label={p.slug}
                  detail={
                    p.code.length > 0
                      ? `code: ${p.code.join(", ")}`
                      : "no code repos declared"
                  }
                  status={p.status}
                />
              ))}
            </div>
          </section>
        )}

        {Object.keys(manifest.runtimes).length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={sectionTitleStyle}>
              Runtime Systems ({Object.keys(manifest.runtimes).length})
            </h2>
            <div style={listStyle}>
              {Object.entries(manifest.runtimes).map(([name, runtime]) => (
                <PointerRow
                  key={name}
                  label={name}
                  detail={describeRuntime(runtime)}
                />
              ))}
            </div>
          </section>
        )}

        {Object.keys(manifest.external_systems).length > 0 && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={sectionTitleStyle}>
              External Systems ({Object.keys(manifest.external_systems).length})
            </h2>
            <div style={listStyle}>
              {Object.entries(manifest.external_systems).map(([name, sys]) => (
                <PointerRow
                  key={name}
                  label={name}
                  detail={describeRuntime(sys)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Encryption tiers */}
        {(manifest.access.sensitive.length > 0 ||
          manifest.access.confidential.length > 0 ||
          manifest.access.restricted.length > 0) && (
          <section style={{ marginBottom: 32 }}>
            <h2 style={sectionTitleStyle}>Access Tiers</h2>
            <div style={listStyle}>
              {manifest.access.sensitive.length > 0 && (
                <PointerRow
                  label="sensitive (Tier 2)"
                  detail={`${manifest.access.sensitive.length} glob(s)`}
                />
              )}
              {manifest.access.confidential.length > 0 && (
                <PointerRow
                  label="confidential (Tier 2)"
                  detail={`${manifest.access.confidential.length} glob(s)`}
                />
              )}
              {manifest.access.restricted.length > 0 && (
                <PointerRow
                  label="restricted (Tier 3)"
                  detail={`${manifest.access.restricted.length} glob(s)`}
                />
              )}
              {manifest.access.externalized_only.length > 0 && (
                <PointerRow
                  label="externalized only (Tier 4)"
                  detail={`${manifest.access.externalized_only.length} glob(s)`}
                />
              )}
            </div>
          </section>
        )}

        {/* AI-loop budget */}
        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionTitleStyle}>AI-Loop Budget</h2>
          <div style={listStyle}>
            <PointerRow
              label="monthly cap"
              detail={`$${manifest.ai_loops.monthly_budget_usd.toLocaleString()}`}
            />
            <PointerRow
              label="peak per run"
              detail={`$${manifest.ai_loops.peak_run_dollars.toLocaleString()}`}
            />
            <PointerRow
              label="throttle mode"
              detail={manifest.ai_loops.detector_throttle_mode}
            />
          </div>
        </section>

        {/* Build status notice */}
        <div
          style={{
            padding: 24,
            background: "var(--ctp-surface0)",
            border: "1px dashed var(--border-default)",
            borderRadius: 12,
            color: "var(--ctp-subtext1)",
            fontSize: "var(--text-sm)",
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            v1 placeholder view
          </div>
          <div>
            Per-folder Environment Panels (drift detection, runtime integration,
            ChangeSet UI) are deferred to subsequent build phases per the
            implementation order in{" "}
            <code>## Index Coherence and Drift Architecture</code>. Today this
            view proves the manifest parses, the IPC bridge delivers it, and the
            seven-folder skeleton is the navigation primitive.
          </div>
        </div>
      </div>
    </div>
  );
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  color: "var(--ctp-overlay1)",
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  marginBottom: 12,
};

const listStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

function PointerRow({
  label,
  detail,
  status,
}: {
  label: string;
  detail: string;
  status?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        padding: "10px 14px",
        background: "var(--ctp-mantle)",
        borderRadius: 8,
        border: "1px solid var(--border-subtle)",
        alignItems: "baseline",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "var(--text-xs)",
          color: "var(--ctp-text)",
          minWidth: 180,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ctp-subtext0)",
          flex: 1,
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        {detail}
      </div>
      {status && (
        <div
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay1)",
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}

function DriftStatPill({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div
      style={{
        padding: "10px 14px",
        background: "var(--ctp-mantle)",
        borderRadius: 8,
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "var(--text-xl, 18px)",
          fontWeight: 600,
          color: color ?? "var(--ctp-text)",
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function describeRuntime(runtime: Record<string, unknown>): string {
  const entries = Object.entries(runtime);
  if (entries.length === 0) return "(no metadata)";
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}
