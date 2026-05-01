/**
 * Shared presentational helpers and hooks for the Business harness verb
 * bodies (Plan / Inspect / Operate). Each verb composes these so the
 * same drift fetch, body wrapper, and section pills aren't reimplemented
 * three times.
 */
import { useEffect, useState } from "react";
import type { HarnessLoopEvent } from "../../global";
import type { HarnessSessionVerify } from "../../lib/harness-types";

export type DriftSeverity =
  | "informational"
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "incident-required";

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
  /** Severity tier; the detector emits the canonical strings, but typo-
   *  safety is light-touch — unknown values fall through to "medium". */
  severity: DriftSeverity | string;
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
 * Drift row. When `onApplied` is provided, renders an apply button that
 * calls `applyCustomerDrift` IPC; on success notifies the parent so it
 * can drop the row. When omitted, the row is read-only — same layout,
 * no actions. This is how Inspect (read-only) and Operate (actionable)
 * share one component instead of two near-identical ones.
 */
export function DriftRow({
  drift,
  onApplied,
}: {
  drift: CustomerDrift;
  onApplied?: (driftId: string) => void;
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
    if (!bridge || !onApplied) return;
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
        gridTemplateColumns: onApplied
          ? "1fr 100px 1fr 1fr 80px"
          : "1fr 100px 1fr 1fr",
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
      {onApplied && (
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
      )}
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

/**
 * Shared outer scroll container for every Business verb body. Same
 * background/padding/max-width that Plan/Inspect/Operate were each
 * inlining before this extraction.
 */
export function BusinessBodyShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex-1 overflow-y-auto"
      style={{
        background: "var(--ctp-base)",
        color: "var(--ctp-text)",
        padding: "32px",
      }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

/**
 * Standard verb-body header: small uppercase verb chip on top, large
 * business name as the H1, monospace root path as a footnote. `actions`
 * renders right-aligned (e.g., the Plan body's Close button).
 */
export function BusinessBodyHeader({
  verb,
  archetype,
  name,
  legalName,
  root,
  actions,
}: {
  verb: string;
  archetype: string;
  name: string;
  legalName?: string;
  root: string;
  actions?: React.ReactNode;
}) {
  return (
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
          {verb} · {archetype}
        </div>
        <h1
          style={{
            fontSize: "var(--text-3xl, 28px)",
            fontWeight: 600,
            color: "var(--ctp-text)",
            margin: 0,
          }}
        >
          {name}
        </h1>
        {legalName && legalName !== name && (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ctp-subtext1)",
              marginTop: 4,
            }}
          >
            {legalName}
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
      {actions}
    </header>
  );
}

/**
 * Cold-open verify drift summary (clean / stale / missing / unindexed).
 * Plan and Inspect both surface it as their first signal that the index
 * is healthy.
 */
export function SessionVerifyPills({
  sessionVerify,
}: {
  sessionVerify: HarnessSessionVerify | null;
}) {
  if (sessionVerify === null) {
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
        Opening index session…
      </div>
    );
  }
  return (
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
        color={sessionVerify.stale.length > 0 ? "var(--ctp-yellow)" : undefined}
      />
      <DriftStatPill
        label="missing"
        value={sessionVerify.missing.length}
        color={sessionVerify.missing.length > 0 ? "var(--ctp-red)" : undefined}
      />
      <DriftStatPill label="unindexed" value={sessionVerify.unindexedCount} />
    </div>
  );
}

/**
 * Inline empty-state card. Italic, mantle-background, bordered. Used
 * when a section legitimately has nothing to show ("No open drifts",
 * "No indexed artifacts under this folder yet"). Distinct from
 * Placeholder — that's a "Phase 2" coming-soon card; this is real
 * content saying "nothing here right now."
 */
export function InlineEmpty({
  text,
  hint,
}: {
  text: string;
  hint?: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: 12,
        fontSize: "var(--text-xs)",
        color: "var(--ctp-overlay1)",
        fontStyle: "italic",
        background: "var(--ctp-mantle)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
      }}
    >
      {text}
      {hint && (
        <div
          style={{
            marginTop: 6,
            fontSize: "var(--text-2xs)",
            color: "var(--ctp-overlay0)",
            fontStyle: "normal",
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * Hook: fetch open customer-account drifts on mount and expose
 * `removeDrift(id)` for the Operate body's apply-button flow.
 *
 * Inspect and Operate both render drifts (Inspect read-only, Operate with
 * apply buttons), so without this they'd each fire `detectCustomerDrift`
 * on mount and the Inspect view wouldn't reflect a drift just resolved
 * in Operate. Calling sites mount this in their own bodies for now;
 * Phase 2 may lift to a Workspace-level provider so apply state actually
 * shares across both bodies without a refetch — for now each verb gets
 * a fresh detection but Operate's `removeDrift` updates only its local
 * list (Inspect refetches on next mount).
 */
export interface UseCustomerDriftResult {
  drifts: CustomerDrift[];
  unobserved: string[];
  loading: boolean;
  error: string | null;
  removeDrift: (id: string) => void;
}

export function useCustomerDrift(): UseCustomerDriftResult {
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
    let mounted = true;
    bridge
      .detectCustomerDrift()
      .then((res) => {
        if (!mounted) return;
        setDrifts(res.drifts);
        setUnobserved(res.unobserved_accounts);
      })
      .catch((e) => {
        if (!mounted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return {
    drifts,
    unobserved,
    loading,
    error,
    removeDrift: (id: string) =>
      setDrifts((prev) => prev.filter((d) => d.id !== id)),
  };
}
