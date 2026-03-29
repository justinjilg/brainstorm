/**
 * Audit Logger — append-only tool call audit trail.
 *
 * Records every tool call with sanitized arguments, result status,
 * duration, model, and cost. Stored in SQLite audit_log table.
 */

import { getDb } from "@brainst0rm/db";
import type {
  AgentMiddleware,
  MiddlewareToolResult,
} from "../middleware/types.js";

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "key",
  "credential",
  "authorization",
]);

/**
 * Sanitize tool arguments by redacting sensitive fields.
 */
function sanitizeArgs(input: Record<string, unknown>): string {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 500) {
      sanitized[key] = value.slice(0, 500) + "...";
    } else {
      sanitized[key] = value;
    }
  }
  return JSON.stringify(sanitized);
}

/**
 * Create audit logging middleware.
 * Records every tool call to the audit_log table.
 */
export function createAuditMiddleware(sessionId: string): AgentMiddleware {
  return {
    name: "audit-logger",

    afterToolResult(result: MiddlewareToolResult): void {
      try {
        const db = getDb();
        db.prepare(
          `INSERT INTO audit_log (session_id, tool_name, args_json, result_ok, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, unixepoch())`,
        ).run(
          sessionId,
          result.name,
          null, // args not available in afterToolResult — logged from wrapToolCall
          result.ok ? 1 : 0,
          result.durationMs,
        );
      } catch {
        // Best effort — don't crash on audit failures
      }
    },

    wrapToolCall(call) {
      try {
        const db = getDb();
        db.prepare(
          `INSERT INTO audit_log (session_id, tool_name, args_json, result_ok, duration_ms, created_at)
           VALUES (?, ?, ?, 1, 0, unixepoch())`,
        ).run(sessionId, call.name, sanitizeArgs(call.input));
      } catch {
        // Best effort
      }
    },
  };
}

/**
 * Query audit log entries for a session.
 */
export function getAuditLog(
  sessionId?: string,
  limit = 50,
): Array<{
  id: number;
  sessionId: string;
  toolName: string;
  argsJson: string | null;
  resultOk: boolean;
  durationMs: number | null;
  createdAt: number;
}> {
  const db = getDb();
  const query = sessionId
    ? db.prepare(
        "SELECT * FROM audit_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
      )
    : db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?");

  const rows = sessionId ? query.all(sessionId, limit) : query.all(limit);
  return (rows as any[]).map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    toolName: r.tool_name,
    argsJson: r.args_json,
    resultOk: r.result_ok === 1,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  }));
}
