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

import { useEffect, useState } from "react";
import type { BusinessToml } from "@brainst0rm/config";
import type { HarnessSessionVerify } from "../../lib/harness-types";

interface BusinessHarnessViewProps {
  root: string;
  manifest: BusinessToml;
  /** Cold-open verification result. null while pending or unavailable. */
  sessionVerify: HarnessSessionVerify | null;
  onClose: () => void;
}

interface FolderArtifact {
  relative_path: string;
  artifact_kind: string;
  owner: string | null;
  status: string | null;
  reviewed_at: string | null;
  size_bytes: number;
  mtime_ms: number;
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
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [folderContents, setFolderContents] = useState<FolderArtifact[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);

  useEffect(() => {
    if (!selectedFolder) {
      setFolderContents([]);
      return;
    }
    const bridge = window.brainstorm;
    if (!bridge) {
      setFolderContents([]);
      setFolderLoading(false);
      return;
    }
    setFolderLoading(true);
    bridge
      .listHarnessFolder(selectedFolder)
      .then((res) => {
        if (res.folder === selectedFolder) {
          setFolderContents(res.artifacts);
        }
      })
      .catch(() => {
        setFolderContents([]);
      })
      .finally(() => setFolderLoading(false));
  }, [selectedFolder]);

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
            {SEVEN_FOLDERS.map((folder) => {
              const isSelected = selectedFolder === folder.slug;
              return (
                <button
                  key={folder.slug}
                  onClick={() =>
                    setSelectedFolder(isSelected ? null : folder.slug)
                  }
                  className="interactive"
                  style={{
                    padding: 16,
                    background: isSelected
                      ? "var(--ctp-surface1)"
                      : "var(--ctp-surface0)",
                    borderRadius: 12,
                    border: `1px solid ${
                      isSelected ? "var(--ctp-blue)" : "var(--border-subtle)"
                    }`,
                    cursor: "pointer",
                    textAlign: "left",
                    color: "inherit",
                    font: "inherit",
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
                </button>
              );
            })}
          </div>
          {selectedFolder && (
            <FolderPanel
              folderSlug={selectedFolder}
              artifacts={folderContents}
              loading={folderLoading}
              onClose={() => setSelectedFolder(null)}
            />
          )}
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
      </div>
    </div>
  );
}

function FolderPanel({
  folderSlug,
  artifacts,
  loading,
  onClose,
}: {
  folderSlug: string;
  artifacts: FolderArtifact[];
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        marginTop: 16,
        padding: 20,
        background: "var(--ctp-surface0)",
        borderRadius: 12,
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "var(--text-sm)",
            fontWeight: 600,
            color: "var(--ctp-text)",
          }}
        >
          {folderSlug}/
          <span
            style={{
              marginLeft: 8,
              color: "var(--ctp-overlay1)",
              fontWeight: 400,
              fontSize: "var(--text-xs)",
            }}
          >
            {loading
              ? "loading…"
              : `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <button
          onClick={onClose}
          className="interactive"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay1)",
            background: "transparent",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>

      {!loading && artifacts.length === 0 && (
        <div
          style={{
            padding: 12,
            fontSize: "var(--text-xs)",
            color: "var(--ctp-overlay1)",
            fontStyle: "italic",
          }}
        >
          No indexed artifacts under this folder yet. Run{" "}
          <code>brainstorm harness reindex</code> after adding files, or
          materialize a starter template via{" "}
          <code>brainstorm harness init --template</code>.
        </div>
      )}

      {artifacts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {artifacts.map((a) => (
            <FolderRow key={a.relative_path} artifact={a} folder={folderSlug} />
          ))}
        </div>
      )}

      {folderSlug === "customers" && <CustomersDriftPanel />}
    </div>
  );
}

function CustomersDriftPanel() {
  const [drifts, setDrifts] = useState<
    Array<{
      id: string;
      relative_path: string;
      field_path: string;
      intent_value: string | null;
      observed_value: string | null;
      severity: string;
    }>
  >([]);
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
        marginTop: 16,
        paddingTop: 16,
        borderTop: "1px solid var(--border-subtle)",
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
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ctp-overlay0)",
          }}
        >
          Running detector…
        </div>
      )}

      {error && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ctp-red)",
          }}
        >
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
            <DriftRow key={d.id} drift={d} />
          ))}
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

function DriftRow({
  drift,
}: {
  drift: {
    id: string;
    relative_path: string;
    field_path: string;
    intent_value: string | null;
    observed_value: string | null;
    severity: string;
  };
}) {
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

function FolderRow({
  artifact,
  folder,
}: {
  artifact: FolderArtifact;
  folder: string;
}) {
  const trimmedPath = artifact.relative_path.startsWith(`${folder}/`)
    ? artifact.relative_path.slice(folder.length + 1)
    : artifact.relative_path;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 110px 140px 80px",
        gap: 12,
        alignItems: "baseline",
        padding: "8px 12px",
        background: "var(--ctp-mantle)",
        borderRadius: 6,
        border: "1px solid var(--border-subtle)",
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
        title={artifact.relative_path}
      >
        {trimmedPath}
      </div>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {artifact.artifact_kind}
      </div>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-subtext1)",
          fontFamily: "var(--font-mono, monospace)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={artifact.owner ?? ""}
      >
        {artifact.owner ?? "—"}
      </div>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-overlay0)",
          textAlign: "right",
        }}
      >
        {(artifact.size_bytes / 1024).toFixed(1)} KB
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
