// SQLite audit log per protocol-v1 §8 (anti-contamination via wrapper).
//
// Channel-of-origin discipline is enforced at the AuditLogEntry layer, not
// on individual wire frames. Operator-payload bytes stored verbatim;
// relay-internal annotations live in metadata_sidecar; channel_of_origin is
// stamped server-side and immutable.
//
// Anti-contamination invariants:
//   - For channel_of_origin = 'operator' rows, payload_bytes MUST be the
//     verbatim operator-emitted bytes; metadata_sidecar MUST NOT contain
//     any field that exists in the operator-content payload.
//   - payload_canonical_hash is computed over payload_bytes; mutation by
//     relay invalidates the hash and is detectable on audit replay.

import Database from "better-sqlite3";
import { sha256 } from "@noble/hashes/sha256";

import type { AuditLogEntry, ChannelOfOrigin } from "./types.js";
import { canonicalBytes } from "./canonical.js";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id TEXT,
    ts TEXT NOT NULL,
    channel_of_origin TEXT NOT NULL CHECK (channel_of_origin IN ('operator', 'relay-internal', 'endpoint', 'sandbox')),
    message_type TEXT NOT NULL,
    payload_canonical_hash TEXT NOT NULL,
    payload_bytes BLOB NOT NULL,
    metadata_sidecar TEXT,
    endpoint_id TEXT,
    session_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_command_id ON audit_log(command_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_endpoint_id ON audit_log(endpoint_id)`,
];

export interface AuditAppendInput {
  command_id: string | null;
  ts?: string;
  channel_of_origin: ChannelOfOrigin;
  message_type: string;
  payload_bytes: Uint8Array;
  metadata_sidecar?: Record<string, unknown> | null;
  endpoint_id?: string | null;
  session_id?: string | null;
}

export class AuditLog {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly getByCommandIdStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) {
      this.db.prepare(stmt).run();
    }
    this.insertStmt = this.db.prepare(
      `INSERT INTO audit_log (command_id, ts, channel_of_origin, message_type, payload_canonical_hash, payload_bytes, metadata_sidecar, endpoint_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getByCommandIdStmt = this.db.prepare(
      `SELECT id, command_id, ts, channel_of_origin, message_type, payload_canonical_hash, payload_bytes, metadata_sidecar, endpoint_id, session_id FROM audit_log WHERE command_id = ? ORDER BY id ASC`,
    );
  }

  append(input: AuditAppendInput): number {
    const ts = input.ts ?? new Date().toISOString();
    const hashBytes = sha256(input.payload_bytes);
    const hash = "sha256:" + bytesToHex(hashBytes);
    const sidecar =
      input.metadata_sidecar !== undefined && input.metadata_sidecar !== null
        ? JSON.stringify(input.metadata_sidecar)
        : null;
    const result = this.insertStmt.run(
      input.command_id,
      ts,
      input.channel_of_origin,
      input.message_type,
      hash,
      Buffer.from(input.payload_bytes),
      sidecar,
      input.endpoint_id ?? null,
      input.session_id ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  appendCanonical(
    input: Omit<AuditAppendInput, "payload_bytes"> & {
      payload: unknown;
    },
  ): number {
    if (input.channel_of_origin === "operator") {
      throw new Error(
        "appendCanonical() must NOT be used for channel_of_origin='operator'; " +
          "use append() with verbatim operator bytes to preserve anti-contamination invariant",
      );
    }
    const payload_bytes = canonicalBytes(input.payload);
    return this.append({
      command_id: input.command_id,
      ts: input.ts,
      channel_of_origin: input.channel_of_origin,
      message_type: input.message_type,
      payload_bytes,
      metadata_sidecar: input.metadata_sidecar,
      endpoint_id: input.endpoint_id,
      session_id: input.session_id,
    });
  }

  getByCommandId(command_id: string): AuditLogEntry[] {
    const rows = this.getByCommandIdStmt.all(command_id) as Array<{
      id: number;
      command_id: string;
      ts: string;
      channel_of_origin: ChannelOfOrigin;
      message_type: string;
      payload_canonical_hash: string;
      payload_bytes: Buffer;
      metadata_sidecar: string | null;
      endpoint_id: string | null;
      session_id: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      command_id: row.command_id,
      ts: row.ts,
      channel_of_origin: row.channel_of_origin,
      message_type: row.message_type,
      payload_canonical_hash: row.payload_canonical_hash,
      payload_bytes_b64: row.payload_bytes.toString("base64"),
      metadata_sidecar: row.metadata_sidecar
        ? JSON.parse(row.metadata_sidecar)
        : null,
      endpoint_id: row.endpoint_id,
      session_id: row.session_id,
    }));
  }

  verifyHash(id: number): boolean {
    const row = this.db
      .prepare(
        `SELECT payload_bytes, payload_canonical_hash FROM audit_log WHERE id = ?`,
      )
      .get(id) as
      | { payload_bytes: Buffer; payload_canonical_hash: string }
      | undefined;
    if (!row) return false;
    const expectedHash =
      "sha256:" + bytesToHex(sha256(new Uint8Array(row.payload_bytes)));
    return expectedHash === row.payload_canonical_hash;
  }

  close(): void {
    this.db.close();
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
