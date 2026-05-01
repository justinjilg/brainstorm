/**
 * Shared presentational helpers for the Business harness verb bodies
 * (Plan / Inspect / Operate). Extracted from the original monolithic
 * BusinessHarnessView during the Group B split so each verb body can
 * compose them without duplication.
 *
 * No behavior change — these are the same components as before, just
 * lifted to a shared module.
 */
import { useState } from "react";
import type { HarnessLoopEvent } from "../../global";

export interface FolderArtifact {
  relative_path: string;
  artifact_kind: string;
  owner: string | null;
  status: string | null;
  reviewed_at: number | null;
  size_bytes: number;
  mtime_ms: number;
}

export interface CustomerDrift {
  id: string;
  relative_path: string;
  field_path: string;
  intent_value: string | null;
  observed_value: string | null;
  severity: string;
}

export const SEVEN_FOLDERS: ReadonlyArray<{
  slug: string;
  label: string;
  why: string;
}> = [
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

export const sectionTitleStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  color: "var(--ctp-overlay1)",
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  marginBottom: 12,
};

export const listStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

export function PointerRow({
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

export function DriftStatPill({
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

export function describeRuntime(runtime: Record<string, unknown>): string {
  const entries = Object.entries(runtime);
  if (entries.length === 0) return "(no metadata)";
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}

export function FolderRow({
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

/**
 * Apply-button row for a single intent↔runtime drift. Lives in the
 * Operate verb body. Calls `applyCustomerDrift` IPC and notifies the
 * parent so it can drop the row from the open-drifts list.
 */
export function DriftRow({
  drift,
  onApplied,
}: {
  drift: CustomerDrift;
  onApplied: (driftId: string) => void;
}) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const severityColor =
    drift.severity === "critical"
      ? "var(--ctp-red)"
      : drift.severity === "high"
        ? "var(--ctp-yellow)"
        : "var(--ctp-overlay1)";

  async function handleApply() {
    const bridge = window.brainstorm;
    if (!bridge) return;
    setApplying(true);
    setError(null);
    try {
      const res = await bridge.applyCustomerDrift(drift.id);
      if (res.ok) {
        onApplied(drift.id);
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 100px 1fr 1fr 80px",
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
      <button
        onClick={handleApply}
        disabled={applying}
        className="interactive"
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ctp-text)",
          background: "var(--ctp-surface1)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 4,
          padding: "4px 8px",
          cursor: applying ? "default" : "pointer",
          opacity: applying ? 0.5 : 1,
        }}
        title={
          error
            ? `Last error: ${error}`
            : `Apply intent (${drift.intent_value}) to runtime`
        }
      >
        {applying ? "applying…" : "apply"}
      </button>
    </div>
  );
}

export function LoopEventLog({ events }: { events: HarnessLoopEvent[] }) {
  const recent = events.slice(-8).reverse();
  if (recent.length === 0) {
    return (
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
        Loops are scheduled — first events arrive within seconds of opening the
        session.
      </div>
    );
  }
  return (
    <div
      style={{
        background: "var(--ctp-mantle)",
        borderRadius: 8,
        border: "1px solid var(--border-subtle)",
        overflow: "hidden",
      }}
    >
      {recent.map((event, idx) => (
        <LoopEventRow key={`${event.at}-${event.loop}-${idx}`} event={event} />
      ))}
    </div>
  );
}

export function LoopEventRow({ event }: { event: HarnessLoopEvent }) {
  const statusColor =
    event.status === "failed"
      ? "var(--ctp-red)"
      : event.status === "completed"
        ? "var(--ctp-green)"
        : "var(--ctp-overlay1)";
  const detail = event.error
    ? `error: ${event.error}`
    : event.summary
      ? Object.entries(event.summary)
          .map(([k, v]) => `${k}=${formatLoopValue(v)}`)
          .join(" · ")
      : "";
  const time = new Date(event.at).toLocaleTimeString();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "82px 130px 70px 1fr",
        gap: 10,
        padding: "6px 12px",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "var(--text-2xs)",
        borderTop: "1px solid var(--border-subtle)",
      }}
    >
      <div style={{ color: "var(--ctp-overlay0)" }}>{time}</div>
      <div style={{ color: "var(--ctp-text)" }}>{event.loop}</div>
      <div style={{ color: statusColor }}>{event.status}</div>
      <div
        style={{
          color: "var(--ctp-subtext1)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={detail}
      >
        {detail}
      </div>
    </div>
  );
}

export function formatLoopValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
