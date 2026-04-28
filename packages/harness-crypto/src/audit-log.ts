import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Audit log writer for the harness.
 *
 * Per spec PQC §4.5 ("Audit trail" / "Auditable but encrypted"): every
 * decryption + encryption + capability-grant event logs to
 * `.harness/audit/decrypt-log.md` (path is markdown but content is JSONL —
 * the `.md` extension is convenience for readers who view the raw file).
 *
 * The log is **append-only** and content-hash-chained (each entry includes
 * the SHA-256 of the previous entry's serialized JSON, so tampering with
 * old entries breaks the chain at the next entry).
 *
 * v1.5 status: this module writes plaintext audit logs. PQC §4.5 calls for
 * encrypting the log to founder + archive identity; that's a v2 enhancement
 * once the recipient-bundle architecture is fully wired in production. The
 * append-only + hash-chain properties hold either way.
 */

export type AuditEventKind =
  | "encrypt"
  | "decrypt"
  | "encrypt-failure"
  | "decrypt-failure"
  | "capability-grant"
  | "capability-revoke"
  | "ratchet-start"
  | "ratchet-complete"
  | "ratchet-abort"
  | "drift-detected"
  | "changeset-applied"
  | "key-rotation";

export interface AuditEventBase {
  kind: AuditEventKind;
  /** ISO 8601 UTC timestamp. */
  at: string;
  /** "human" | "agent". */
  actor_type: "human" | "agent";
  /** team/humans/{slug} or team/agents/{slug}. */
  actor_ref: string;
  /** Free-text reason captured from the call site. */
  reason: string;
}

export interface EncryptDecryptEvent extends AuditEventBase {
  kind: "encrypt" | "decrypt" | "encrypt-failure" | "decrypt-failure";
  artifact_path: string;
  bundle_id?: string;
  capability_grant_id?: string;
  plaintext_sha256?: string;
  error?: string;
}

export interface CapabilityEvent extends AuditEventBase {
  kind: "capability-grant" | "capability-revoke";
  agent_ref: string;
  bundle_id: string;
  scope?: string[];
  expires_at?: string;
}

export interface RatchetEvent extends AuditEventBase {
  kind: "ratchet-start" | "ratchet-complete" | "ratchet-abort";
  ratchet_id: string;
  bundle_id: string;
  files_touched?: number;
  error?: string;
}

export interface DriftEvent extends AuditEventBase {
  kind: "drift-detected";
  drift_id: string;
  field_class: string;
  artifact_path: string;
  detector_name: string;
  severity?: string;
}

export interface ChangeSetEvent extends AuditEventBase {
  kind: "changeset-applied";
  changeset_id: string;
  changeset_kind: string;
  drift_id?: string;
  artifact_path?: string;
}

export interface KeyRotationEvent extends AuditEventBase {
  kind: "key-rotation";
  key_class: string;
  old_key_id?: string;
  new_key_id?: string;
}

export type AuditEvent =
  | EncryptDecryptEvent
  | CapabilityEvent
  | RatchetEvent
  | DriftEvent
  | ChangeSetEvent
  | KeyRotationEvent;

/** Conventional location of the audit log inside a harness root. */
export const AUDIT_LOG_PATH = ".harness/audit/decrypt-log.md";

/**
 * Writer for the audit log. Each `append()` call is independent and
 * append-only; concurrent calls from the same process are safe (Node's
 * `appendFileSync` uses O_APPEND). Cross-process concurrency is also safe
 * on POSIX as long as each line is ≤PIPE_BUF (4KB on Linux, ~8KB+ on
 * BSDs/macOS) — JSONL entries are well within this.
 */
export class AuditLogWriter {
  private prevSha: string | null = null;

  constructor(private readonly logPath: string) {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.prevSha = this.lastChainHash();
  }

  /** Append an event; returns the entry's chain hash. */
  append(event: AuditEvent): string {
    const seq = this.nextSeq();
    const entry = {
      seq,
      prev_sha256: this.prevSha,
      ...event,
    };
    const json = JSON.stringify(entry);
    appendFileSync(this.logPath, json + "\n", "utf-8");
    this.prevSha = sha256(json);
    return this.prevSha;
  }

  /** Verify that no entry in the log has been tampered with by replaying
   *  the chain. Returns the index of the first bad entry (or -1 if clean). */
  verifyChain():
    | { ok: true }
    | { ok: false; firstBadIndex: number; reason: string } {
    if (!existsSync(this.logPath)) return { ok: true };
    const lines = readFileSync(this.logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    let prev: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let parsed: { seq: number; prev_sha256: string | null };
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        return {
          ok: false,
          firstBadIndex: i,
          reason: `parse error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      if (parsed.prev_sha256 !== prev) {
        return {
          ok: false,
          firstBadIndex: i,
          reason: `prev_sha256 mismatch at entry ${i}: expected ${prev}, got ${parsed.prev_sha256}`,
        };
      }
      prev = sha256(line);
    }
    return { ok: true };
  }

  /** Read all entries (untyped — caller narrows by `kind`). */
  read(): Array<AuditEvent & { seq: number; prev_sha256: string | null }> {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  }

  private nextSeq(): number {
    if (!existsSync(this.logPath)) return 1;
    const content = readFileSync(this.logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return 1;
    try {
      const last = JSON.parse(lines[lines.length - 1]!) as { seq?: number };
      return (last.seq ?? 0) + 1;
    } catch {
      return lines.length + 1;
    }
  }

  private lastChainHash(): string | null {
    if (!existsSync(this.logPath)) return null;
    const content = readFileSync(this.logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    return sha256(lines[lines.length - 1]!);
  }
}

/** Build the full audit log path inside a harness root. */
export function auditLogPath(harnessRoot: string): string {
  return join(harnessRoot, AUDIT_LOG_PATH);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
