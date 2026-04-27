// Persistent nonce-replay store per protocol-v1 §3.3.
//
// Replay-prevention requirements (mandatory, not implementer choice):
//   - Persistent across endpoint restarts (NOT in-memory only)
//   - Minimum capacity: 100,000 nonces
//   - Eviction-eligibility: entries older than max(expires_at) + 60s clock skew
//   - Fail-closed under capacity pressure: if capacity is fully occupied
//     with non-evictable entries, REJECT new envelopes with NONCE_CACHE_FULL
//     rather than evicting unexpired entries
//   - Duplicate nonce within retention window → NONCE_REPLAY rejection

import Database from "better-sqlite3";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    seen_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nonces_expires_at ON nonces(expires_at)`,
];

const CLOCK_SKEW_SECONDS = 60;

export interface NonceStoreOptions {
  dbPath: string;
  capacity?: number;
}

export type NonceCheckResult =
  | { ok: true }
  | { ok: false; reason: "NONCE_REPLAY" | "NONCE_CACHE_FULL" };

export class NonceStore {
  private readonly db: Database.Database;
  private readonly capacity: number;
  private readonly checkAndInsertStmt: Database.Statement;
  private readonly evictExpiredStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(options: NonceStoreOptions) {
    if (options.capacity !== undefined && options.capacity < 100_000) {
      throw new Error(
        `NonceStore capacity must be >= 100_000 per spec §3.3; got ${options.capacity}`,
      );
    }
    this.capacity = options.capacity ?? 100_000;
    this.db = new Database(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    for (const stmt of SCHEMA_STATEMENTS) {
      this.db.prepare(stmt).run();
    }
    this.checkAndInsertStmt = this.db.prepare(
      `INSERT INTO nonces (nonce, expires_at, seen_at) VALUES (?, ?, ?) ON CONFLICT(nonce) DO NOTHING`,
    );
    this.evictExpiredStmt = this.db.prepare(
      `DELETE FROM nonces WHERE expires_at < ?`,
    );
    this.countStmt = this.db.prepare(`SELECT COUNT(*) as c FROM nonces`);
  }

  checkAndRecord(nonce: string, expiresAt: string): NonceCheckResult {
    const now = new Date();
    const evictionCutoff = new Date(
      now.getTime() - CLOCK_SKEW_SECONDS * 1000,
    ).toISOString();

    const txn = this.db.transaction(() => {
      this.evictExpiredStmt.run(evictionCutoff);

      const row = this.countStmt.get() as { c: number };
      if (row.c >= this.capacity) {
        return { ok: false as const, reason: "NONCE_CACHE_FULL" as const };
      }

      const result = this.checkAndInsertStmt.run(
        nonce,
        expiresAt,
        now.toISOString(),
      );
      if (result.changes === 0) {
        return { ok: false as const, reason: "NONCE_REPLAY" as const };
      }
      return { ok: true as const };
    });

    return txn();
  }

  evictExpired(): number {
    const evictionCutoff = new Date(
      Date.now() - CLOCK_SKEW_SECONDS * 1000,
    ).toISOString();
    return this.evictExpiredStmt.run(evictionCutoff).changes;
  }

  count(): number {
    return (this.countStmt.get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }
}
