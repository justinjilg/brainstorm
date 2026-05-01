/**
 * Business · Plan verb body. Identity header, the Seven Universal Folders
 * nav grid + per-folder artifact panel, and federation pointer rows
 * (products, runtimes, external systems, access tiers, AI-loop budget).
 * Drift detection + AI-loop event stream live under Inspect.
 */
import { useEffect, useState } from "react";
import type { BusinessToml } from "@brainst0rm/config";
import {
  SEVEN_FOLDERS,
  BusinessBodyHeader,
  BusinessBodyShell,
  InlineEmpty,
  PointerRow,
  FolderRow,
  SessionVerifyPills,
  describeRuntime,
  sectionTitleStyle,
  listStyle,
  type FolderArtifact,
} from "./BusinessHarnessShared";
import type { HarnessSessionVerify } from "../../lib/harness-types";

interface BusinessPlanBodyProps {
  root: string;
  manifest: BusinessToml;
  sessionVerify: HarnessSessionVerify | null;
  onClose: () => void;
}

export function BusinessPlanBody({
  root,
  manifest,
  sessionVerify,
  onClose,
}: BusinessPlanBodyProps) {
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
    let mounted = true;
    setFolderLoading(true);
    bridge
      .listHarnessFolder(selectedFolder)
      .then((res) => {
        if (mounted && res.folder === selectedFolder) {
          setFolderContents(res.artifacts);
        }
      })
      .catch(() => {
        if (mounted) setFolderContents([]);
      })
      .finally(() => {
        if (mounted) setFolderLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [selectedFolder]);

  return (
    <BusinessBodyShell>
      <BusinessBodyHeader
        verb="Business Harness"
        archetype={manifest.identity.archetype}
        name={manifest.identity.name}
        legalName={manifest.identity.legal_name}
        root={root}
        actions={
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
        }
      />

      {sessionVerify && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={sectionTitleStyle}>Index Session</h2>
          <SessionVerifyPills sessionVerify={sessionVerify} />
        </section>
      )}

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
    </BusinessBodyShell>
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
        <InlineEmpty
          text="No indexed artifacts under this folder yet."
          hint={
            <>
              Run <code>brainstorm harness reindex</code> after adding files, or
              materialize a starter template via{" "}
              <code>brainstorm harness init --template</code>.
            </>
          }
        />
      )}

      {artifacts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {artifacts.map((a) => (
            <FolderRow key={a.relative_path} artifact={a} folder={folderSlug} />
          ))}
        </div>
      )}
    </div>
  );
}
