/**
 * Universal ChangeSet renderer — one React component that renders any
 * ChangeSet regardless of which product produced it. Replaces the
 * per-product custom views that existed before.
 *
 * Authored as opus PR 6. Built against @brainst0rm/changeset-contract
 * v2 (opus PR #367) so all 5 products' ChangeSets render through this
 * single component.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ HEADER:  <product>.<action>          [risk-pill (0-100)] │
 *   │          <description>                                   │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ BLAST RADIUS: N entities · 1 tenant · pii,config        │
 *   │               reversibility: instant                     │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ CHANGES (N):                                             │
 *   │   • update device:abc — { network: connected→isolated }  │
 *   │   • ...                                                  │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ COST ESTIMATE: $0.17/hour (c5.xlarge VM-hour)            │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ CASCADES: VPN disconnected, alerting silenced            │
 *   │ CONSTRAINTS: tenant is over quota                        │
 *   ├─────────────────────────────────────────────────────────┤
 *   │   [Cancel]                          [Approve & Execute] │
 *   └─────────────────────────────────────────────────────────┘
 */

import type {
  ChangeSet,
  Change,
  BlastRadius,
  CostEstimate,
} from "@brainst0rm/changeset-contract";
import { riskLevelOf } from "./risk-level.js";

interface ChangeSetCardProps {
  changeset: ChangeSet;
  onApprove?: (id: string) => void | Promise<void>;
  onCancel?: (id: string) => void | Promise<void>;
  /** Disable approval button (e.g. for read-only display in audit views). */
  readOnly?: boolean;
}

export function ChangeSetCard({
  changeset,
  onApprove,
  onCancel,
  readOnly = false,
}: ChangeSetCardProps) {
  const isTerminal =
    changeset.status === "executed" ||
    changeset.status === "failed" ||
    changeset.status === "rejected" ||
    changeset.status === "expired" ||
    changeset.status === "rolled_back";

  return (
    <div className="changeset-card" data-status={changeset.status}>
      <ChangeSetHeader changeset={changeset} />
      {changeset.simulation.blastRadius ? (
        <BlastRadiusSummary blastRadius={changeset.simulation.blastRadius} />
      ) : null}
      <ChangesList changes={changeset.changes} />
      {changeset.simulation.costEstimate ? (
        <CostEstimateLine estimate={changeset.simulation.costEstimate} />
      ) : null}
      {changeset.simulation.cascades.length > 0 ? (
        <CascadesLine cascades={changeset.simulation.cascades} />
      ) : null}
      {changeset.simulation.constraints.length > 0 ? (
        <ConstraintsLine constraints={changeset.simulation.constraints} />
      ) : null}
      <RiskFactorsLine factors={changeset.riskFactors} />
      <TenantBadge tenantId={changeset.tenantId} />
      {!readOnly && !isTerminal && changeset.status === "draft" ? (
        <ChangeSetActions
          changeset={changeset}
          onApprove={onApprove}
          onCancel={onCancel}
        />
      ) : (
        <TerminalStateBadge changeset={changeset} />
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function ChangeSetHeader({ changeset }: { changeset: ChangeSet }) {
  return (
    <header className="changeset-header">
      <div className="changeset-identity">
        <div className="changeset-action">
          <span className="changeset-product">{changeset.connector}</span>
          <span className="changeset-dot">·</span>
          <span className="changeset-tool">{changeset.action}</span>
        </div>
        <p className="changeset-description">{changeset.description}</p>
      </div>
      <RiskPill score={changeset.riskScore} status={changeset.status} />
    </header>
  );
}

function RiskPill({
  score,
  status,
}: {
  score: number;
  status: ChangeSet["status"];
}) {
  const level = riskLevelOf(score);
  return (
    <div
      className={`risk-pill risk-${level} status-${status}`}
      title={`Risk ${score}/100 — ${level}`}
    >
      <span className="risk-score">{score}</span>
      <span className="risk-label">{level.toUpperCase()}</span>
    </div>
  );
}

function BlastRadiusSummary({ blastRadius }: { blastRadius: BlastRadius }) {
  // Render operational fields if present (v2 ChangeSets); fall back to
  // code-structural fields for v1-shaped ChangeSets.
  const op = {
    entities: blastRadius.entitiesAffected,
    products: blastRadius.productsTouched,
    tenants: blastRadius.tenantsTouched,
    classes: blastRadius.dataClasses,
    reversibility: blastRadius.reversibility,
  };
  const hasOp =
    op.entities !== undefined ||
    op.products !== undefined ||
    op.tenants !== undefined ||
    op.classes !== undefined ||
    op.reversibility !== undefined;

  return (
    <section className="changeset-blast-radius">
      <h4>Blast radius</h4>
      {hasOp ? (
        <ul className="blast-operational">
          {op.entities !== undefined ? (
            <li>
              <span className="label">entities affected</span>
              <span className="value">{op.entities}</span>
            </li>
          ) : null}
          {op.products && op.products.length > 0 ? (
            <li>
              <span className="label">products touched</span>
              <span className="value">{op.products.join(", ")}</span>
            </li>
          ) : null}
          {op.tenants && op.tenants.length > 0 ? (
            <li>
              <span className="label">tenants touched</span>
              <span className="value">{op.tenants.join(", ")}</span>
            </li>
          ) : null}
          {op.classes && op.classes.length > 0 ? (
            <li>
              <span className="label">data classes</span>
              <span className="value">{op.classes.join(", ")}</span>
            </li>
          ) : null}
          {op.reversibility ? (
            <li>
              <span className="label">reversibility</span>
              <span
                className={`value reversibility-${op.reversibility}`}
                title={reversibilityTooltip(op.reversibility)}
              >
                {op.reversibility}
              </span>
            </li>
          ) : null}
        </ul>
      ) : (
        <ul className="blast-code-structural">
          <li>
            <span className="label">symbols affected</span>
            <span className="value">{blastRadius.totalAffected ?? 0}</span>
          </li>
          {blastRadius.affectedCommunities &&
          blastRadius.affectedCommunities.length > 0 ? (
            <li>
              <span className="label">communities</span>
              <span className="value">
                {blastRadius.affectedCommunities.map((c) => c.name).join(", ")}
              </span>
            </li>
          ) : null}
          {blastRadius.riskMultiplier !== undefined ? (
            <li>
              <span className="label">risk multiplier</span>
              <span className="value">×{blastRadius.riskMultiplier}</span>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function reversibilityTooltip(r: BlastRadius["reversibility"]): string {
  switch (r) {
    case "instant":
      return "Immediate undo possible via this ChangeSet's revert().";
    case "manual":
      return "Reversible but requires operator action (e.g. re-enable from backup).";
    case "irreversible":
      return "Gone forever — past retention, force-pushed, or deleted with no backup.";
    default:
      return "";
  }
}

function ChangesList({ changes }: { changes: Change[] }) {
  if (changes.length === 0) return null;
  return (
    <section className="changeset-changes">
      <h4>Changes ({changes.length})</h4>
      <ul>
        {changes.map((c, i) => (
          <li key={`${c.system}:${c.entity}:${i}`}>
            <span className={`change-op op-${c.operation}`}>{c.operation}</span>
            <span className="change-entity">{c.entity}</span>
            <span className="change-system">({c.system})</span>
            {c.before !== undefined && c.after !== undefined ? (
              <span className="change-diff">
                {JSON.stringify(c.before)} → {JSON.stringify(c.after)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CostEstimateLine({ estimate }: { estimate: CostEstimate }) {
  return (
    <section className="changeset-cost">
      <h4>Cost estimate</h4>
      <div className="cost-total">${estimate.usd.toFixed(4)}</div>
      {Object.keys(estimate.breakdown).length > 0 ? (
        <ul className="cost-breakdown">
          {Object.entries(estimate.breakdown).map(([sku, amount]) => (
            <li key={sku}>
              <span className="cost-sku">{sku}</span>
              <span className="cost-amount">${amount.toFixed(4)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CascadesLine({ cascades }: { cascades: string[] }) {
  return (
    <section className="changeset-cascades">
      <h4>Cascades</h4>
      <ul>
        {cascades.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </section>
  );
}

function ConstraintsLine({ constraints }: { constraints: string[] }) {
  return (
    <section className="changeset-constraints">
      <h4>Constraints</h4>
      <ul>
        {constraints.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </section>
  );
}

function RiskFactorsLine({ factors }: { factors: string[] }) {
  if (factors.length === 0) return null;
  return (
    <section className="changeset-risk-factors">
      <h4>Risk factors</h4>
      <ul>
        {factors.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
    </section>
  );
}

function TenantBadge({ tenantId }: { tenantId: string }) {
  return (
    <div
      className={`changeset-tenant-badge ${tenantId ? "" : "missing-tenant"}`}
      title={
        tenantId
          ? `Tenant scope: ${tenantId}`
          : "WARNING: no tenantId set. v2 contract requires one — this ChangeSet predates the migration or was synthesized by a buggy connector."
      }
    >
      Tenant: {tenantId || "<unset>"}
    </div>
  );
}

function ChangeSetActions({
  changeset,
  onApprove,
  onCancel,
}: {
  changeset: ChangeSet;
  onApprove?: (id: string) => void | Promise<void>;
  onCancel?: (id: string) => void | Promise<void>;
}) {
  return (
    <footer className="changeset-actions">
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => onCancel?.(changeset.id)}
        disabled={!onCancel}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => onApprove?.(changeset.id)}
        disabled={!onApprove}
      >
        Approve &amp; Execute
      </button>
    </footer>
  );
}

function TerminalStateBadge({ changeset }: { changeset: ChangeSet }) {
  return (
    <footer className="changeset-terminal-state">
      <span className={`status-badge status-${changeset.status}`}>
        {changeset.status}
      </span>
      {changeset.executedAt ? (
        <span className="timestamp">
          executed at {new Date(changeset.executedAt).toLocaleString()}
        </span>
      ) : null}
      {changeset.approvedBy ? (
        <span className="approved-by">approved by {changeset.approvedBy}</span>
      ) : null}
    </footer>
  );
}
