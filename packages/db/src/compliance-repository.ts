/**
 * Compliance Event Repository — logs and queries compliance events.
 *
 * Auto-logged on: budget exceedance, high-risk changeset execution,
 * permission escalation, model failover to non-approved provider.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type ComplianceSeverity = "info" | "warning" | "critical";

export interface ComplianceEvent {
  id: string;
  orgId: string;
  userId?: string;
  eventType: string;
  severity: ComplianceSeverity;
  description: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export class ComplianceEventRepository {
  constructor(private db: Database.Database) {}

  log(
    orgId: string,
    event: {
      userId?: string;
      eventType: string;
      severity?: ComplianceSeverity;
      description: string;
      metadata?: Record<string, unknown>;
    },
  ): string {
    const id = randomUUID().slice(0, 12);
    this.db
      .prepare(
        "INSERT INTO compliance_events (id, org_id, user_id, event_type, severity, description, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        orgId,
        event.userId ?? null,
        event.eventType,
        event.severity ?? "info",
        event.description,
        JSON.stringify(event.metadata ?? {}),
      );
    return id;
  }

  list(
    orgId: string,
    opts?: {
      severity?: ComplianceSeverity;
      eventType?: string;
      since?: number;
      limit?: number;
    },
  ): ComplianceEvent[] {
    let sql = "SELECT * FROM compliance_events WHERE org_id = ?";
    const params: any[] = [orgId];

    if (opts?.severity) {
      sql += " AND severity = ?";
      params.push(opts.severity);
    }
    if (opts?.eventType) {
      sql += " AND event_type = ?";
      params.push(opts.eventType);
    }
    if (opts?.since) {
      sql += " AND created_at > ?";
      params.push(opts.since);
    }

    sql += " ORDER BY created_at DESC";
    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    return (this.db.prepare(sql).all(...params) as any[]).map(toEvent);
  }

  summary(
    orgId: string,
    since: number,
  ): {
    total: number;
    bySeverity: Record<ComplianceSeverity, number>;
    byType: Record<string, number>;
  } {
    const events = this.list(orgId, { since });
    const bySeverity: Record<string, number> = {
      info: 0,
      warning: 0,
      critical: 0,
    };
    const byType: Record<string, number> = {};

    for (const e of events) {
      bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
      byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
    }

    return { total: events.length, bySeverity: bySeverity as any, byType };
  }

  /** Generate a full compliance report for export. */
  generateReport(
    orgId: string,
    since: number,
  ): {
    period: { since: number; until: number };
    events: ComplianceEvent[];
    summary: ReturnType<ComplianceEventRepository["summary"]>;
  } {
    const events = this.list(orgId, { since });
    return {
      period: { since, until: Math.floor(Date.now() / 1000) },
      events,
      summary: this.summary(orgId, since),
    };
  }
}

function toEvent(row: any): ComplianceEvent {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    eventType: row.event_type,
    severity: row.severity,
    description: row.description,
    metadata: JSON.parse(row.metadata_json ?? "{}"),
    createdAt: row.created_at,
  };
}
