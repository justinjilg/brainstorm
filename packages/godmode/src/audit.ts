/**
 * God Mode Audit — ChangeSet logging for compliance and traceability.
 *
 * Every executed ChangeSet is logged with its full context:
 * connector, action, changes, risk score, simulation, rollback data.
 *
 * Uses the existing audit_log infrastructure when available,
 * or standalone logging when used outside the full CLI.
 */

import type { ChangeSet } from "./types.js";

/** In-memory audit log (persisted to SQLite via packages/db in CLI context). */
const auditLog: AuditEntry[] = [];

export interface AuditEntry {
  changesetId: string;
  connector: string;
  action: string;
  description: string;
  riskScore: number;
  status: string;
  changesJson: string;
  simulationJson: string;
  rollbackJson: string | null;
  createdAt: number;
  executedAt: number | null;
}

/**
 * Log a ChangeSet to the audit trail.
 * Called automatically by the ChangeSet engine on execution.
 */
export function logChangeSet(changeset: ChangeSet): AuditEntry {
  const entry: AuditEntry = {
    changesetId: changeset.id,
    connector: changeset.connector,
    action: changeset.action,
    description: changeset.description,
    riskScore: changeset.riskScore,
    status: changeset.status,
    changesJson: JSON.stringify(changeset.changes),
    simulationJson: JSON.stringify(changeset.simulation),
    rollbackJson: changeset.rollbackData
      ? JSON.stringify(changeset.rollbackData)
      : null,
    createdAt: changeset.createdAt,
    executedAt: changeset.executedAt ?? null,
  };

  auditLog.push(entry);
  return entry;
}

/**
 * Get the full audit log.
 */
export function getAuditLog(): AuditEntry[] {
  return [...auditLog];
}

/**
 * Get audit entries for a specific connector.
 */
export function getConnectorAuditLog(connector: string): AuditEntry[] {
  return auditLog.filter((e) => e.connector === connector);
}

/**
 * SQL migration for persisting audit log to SQLite.
 * Used by packages/db when God Mode is active.
 */
export const GODMODE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS godmode_changeset_log (
  changeset_id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  status TEXT NOT NULL,
  changes_json TEXT,
  simulation_json TEXT,
  rollback_json TEXT,
  created_at INTEGER NOT NULL,
  executed_at INTEGER,
  session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_gm_changeset_connector ON godmode_changeset_log(connector);
CREATE INDEX IF NOT EXISTS idx_gm_changeset_status ON godmode_changeset_log(status);
CREATE INDEX IF NOT EXISTS idx_gm_changeset_created ON godmode_changeset_log(created_at);
`;
