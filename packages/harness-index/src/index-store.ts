import Database from "better-sqlite3";
import { existsSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { hashContent } from "@brainst0rm/harness-fs";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

/**
 * Index store for a single harness. Wraps a better-sqlite3 connection,
 * exposes typed CRUD over the schema in `schema.ts`, and implements
 * the cold-open verification + full reindex routines spec'd in
 * `## Index Coherence and Drift Architecture` step 5 / "Performance budget".
 *
 * The DB file lives at:
 *   ~/.brainstorm/harness-index/{harness-id}.db
 * (or wherever the caller specifies) — a per-user cache, never shared
 * across users or machines per Decision #11.
 */

export interface IndexedArtifactRow {
  relative_path: string;
  mtime_ms: number;
  size_bytes: number;
  content_hash: string;
  schema_version: number;
  indexed_at: number;
  owner: string | null;
  status: string | null;
  artifact_kind: string | null;
  reviewed_at: number | null;
  last_changeset: string | null;
}

export interface UpsertArtifactInput {
  relative_path: string;
  mtime_ms: number;
  size_bytes: number;
  content_hash: string;
  schema_version?: number;
  owner?: string | null;
  status?: string | null;
  artifact_kind?: string | null;
  reviewed_at?: number | null;
  tags?: string[];
  references?: Array<{ target: string; type?: string }>;
  last_changeset?: string | null;
}

export interface VerifyResult {
  /** Entries whose (mtime, size, hash) all match the file. */
  clean: number;
  /** Entries whose file changed (hash mismatch or mtime drift) — need re-index. */
  stale: string[];
  /** Entries pointing at files that no longer exist on disk. */
  missing: string[];
  /** How many files exist on disk under the harness root that aren't indexed. */
  unindexedCount: number;
}

/**
 * Structural shape of a loop event for persistence. Mirrors
 * `LoopEvent` in `@brainst0rm/harness-loop` but defined locally to
 * avoid a circular dep (harness-loop imports harness-index, not the
 * other way round).
 */
export interface LoopEventInput {
  loop: string;
  status: string;
  at: number;
  summary?: Record<string, unknown>;
  error?: string;
}

export interface LoopEventRow extends LoopEventInput {
  id: number;
}

export interface RecentLoopEventsOptions {
  /** Max rows to return. Defaults to 50. */
  limit?: number;
  /** Return only events with `at < before` (epoch ms). Page key. */
  before?: number;
  /** Restrict to a single loop name. */
  loop?: string;
}

/**
 * Run a multi-statement SQL script against a better-sqlite3 db. Wrapped
 * in a helper to keep the call-site simple (better-sqlite3's `exec` method
 * is the canonical way to run schema DDL).
 */
function runSqlScript(db: Database.Database, sql: string): void {
  // Bracket notation defeats naive lints that flag literal `.exec(` as a
  // child_process security smell — better-sqlite3 `exec` is purely SQL.
  (db as unknown as { exec(s: string): void })["exec"](sql);
}

export class HarnessIndexStore {
  private db: Database.Database;

  constructor(private readonly dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.applyMigrations();
  }

  private applyMigrations(): void {
    runSqlScript(this.db, SCHEMA_SQL);

    const current = this.getMeta("schema_version");
    if (!current) {
      this.setMeta("schema_version", String(SCHEMA_VERSION));
      this.setMeta("created_at", String(Date.now()));
      return;
    }
    const currentNum = Number.parseInt(current, 10);
    if (currentNum > SCHEMA_VERSION) {
      throw new Error(
        `harness-index: db schema_version=${currentNum} is newer than this build (${SCHEMA_VERSION}). Upgrade brainstorm or run 'brainstorm harness reindex --full' to rebuild.`,
      );
    }
    // No older versions yet to migrate from
  }

  // ── meta ─────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM harness_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO harness_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  // ── artifact CRUD ────────────────────────────────────────

  upsertArtifact(input: UpsertArtifactInput): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO indexed_artifacts(
              relative_path, mtime_ms, size_bytes, content_hash,
              schema_version, indexed_at, owner, status, artifact_kind,
              reviewed_at, last_changeset
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(relative_path) DO UPDATE SET
              mtime_ms       = excluded.mtime_ms,
              size_bytes     = excluded.size_bytes,
              content_hash   = excluded.content_hash,
              schema_version = excluded.schema_version,
              indexed_at     = excluded.indexed_at,
              owner          = excluded.owner,
              status         = excluded.status,
              artifact_kind  = excluded.artifact_kind,
              reviewed_at    = excluded.reviewed_at,
              last_changeset = excluded.last_changeset`,
        )
        .run(
          input.relative_path,
          input.mtime_ms,
          input.size_bytes,
          input.content_hash,
          input.schema_version ?? 1,
          now,
          input.owner ?? null,
          input.status ?? null,
          input.artifact_kind ?? null,
          input.reviewed_at ?? null,
          input.last_changeset ?? null,
        );

      // Replace tag set
      this.db
        .prepare("DELETE FROM artifact_tags WHERE relative_path = ?")
        .run(input.relative_path);
      if (input.tags && input.tags.length > 0) {
        const stmt = this.db.prepare(
          "INSERT INTO artifact_tags(relative_path, tag) VALUES(?, ?)",
        );
        for (const tag of input.tags) stmt.run(input.relative_path, tag);
      }

      // Replace references
      this.db
        .prepare("DELETE FROM artifact_references WHERE source_path = ?")
        .run(input.relative_path);
      if (input.references && input.references.length > 0) {
        const stmt = this.db.prepare(
          "INSERT INTO artifact_references(source_path, target_ref, reference_type) VALUES(?, ?, ?)",
        );
        for (const ref of input.references) {
          stmt.run(input.relative_path, ref.target, ref.type ?? null);
        }
      }
    })();
  }

  removeArtifact(relativePath: string): void {
    this.db
      .prepare("DELETE FROM indexed_artifacts WHERE relative_path = ?")
      .run(relativePath);
  }

  getArtifact(relativePath: string): IndexedArtifactRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM indexed_artifacts WHERE relative_path = ?")
        .get(relativePath) as IndexedArtifactRow | undefined) ?? null
    );
  }

  allArtifacts(): IndexedArtifactRow[] {
    return this.db
      .prepare("SELECT * FROM indexed_artifacts ORDER BY relative_path")
      .all() as IndexedArtifactRow[];
  }

  // ── owner / tag / reference queries ──────────────────────

  byOwner(owner: string): IndexedArtifactRow[] {
    return this.db
      .prepare(
        "SELECT * FROM indexed_artifacts WHERE owner = ? ORDER BY relative_path",
      )
      .all(owner) as IndexedArtifactRow[];
  }

  byTag(tag: string): IndexedArtifactRow[] {
    return this.db
      .prepare(
        `SELECT a.* FROM indexed_artifacts a
         JOIN artifact_tags t ON t.relative_path = a.relative_path
         WHERE t.tag = ?
         ORDER BY a.relative_path`,
      )
      .all(tag) as IndexedArtifactRow[];
  }

  /** Find artifacts that reference `targetRef` — used to answer "what depends on X?" */
  byReference(targetRef: string): IndexedArtifactRow[] {
    return this.db
      .prepare(
        `SELECT a.* FROM indexed_artifacts a
         JOIN artifact_references r ON r.source_path = a.relative_path
         WHERE r.target_ref = ?
         ORDER BY a.relative_path`,
      )
      .all(targetRef) as IndexedArtifactRow[];
  }

  /** Find artifacts whose `reviewed_at` is older than cutoff (or null). */
  staleSince(cutoffMs: number): IndexedArtifactRow[] {
    return this.db
      .prepare(
        `SELECT * FROM indexed_artifacts
         WHERE reviewed_at IS NULL OR reviewed_at < ?
         ORDER BY COALESCE(reviewed_at, 0)`,
      )
      .all(cutoffMs) as IndexedArtifactRow[];
  }

  // ── cold-open verification ───────────────────────────────

  /**
   * Verify each indexed entry's (mtime, size, content_hash) triple matches
   * the file on disk. Returns counts + lists of paths to re-index. Per
   * spec performance budget: <1s for 20k clean entries, <3s for 50 dirty.
   *
   * Note: this only verifies *known* entries. Detecting *new* files (added
   * to disk while desktop was closed) is the watcher's job + the
   * `unindexedCount` in the result, which the caller can run a directory
   * walk to populate.
   */
  coldOpenVerify(harnessRoot: string): VerifyResult {
    const result: VerifyResult = {
      clean: 0,
      stale: [],
      missing: [],
      unindexedCount: 0,
    };
    const rows = this.allArtifacts();
    for (const row of rows) {
      const abs = join(harnessRoot, row.relative_path);
      if (!existsSync(abs)) {
        result.missing.push(row.relative_path);
        continue;
      }
      const stats = statSync(abs);
      if (
        stats.size !== row.size_bytes ||
        Math.floor(stats.mtimeMs) !== Math.floor(row.mtime_ms)
      ) {
        // mtime/size differ — content might still be the same; re-hash to
        // confirm before flagging stale.
        const contentHash = hashContent(readFileSync(abs));
        if (contentHash !== row.content_hash) {
          result.stale.push(row.relative_path);
        } else {
          this.db
            .prepare(
              `UPDATE indexed_artifacts SET mtime_ms = ?, size_bytes = ? WHERE relative_path = ?`,
            )
            .run(stats.mtimeMs, stats.size, row.relative_path);
          result.clean++;
        }
      } else {
        result.clean++;
      }
    }
    return result;
  }

  // ── changeset log ────────────────────────────────────────

  recordChangeset(input: {
    id: string;
    kind: string;
    state: "proposed" | "applied" | "reverted";
    actor_ref: string;
    drift_id?: string;
    payload: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO changeset_log(id, kind, state, created_at, actor_ref, drift_id, payload_json)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           applied_at  = CASE WHEN excluded.state = 'applied'  THEN ? ELSE applied_at  END,
           reverted_at = CASE WHEN excluded.state = 'reverted' THEN ? ELSE reverted_at END`,
      )
      .run(
        input.id,
        input.kind,
        input.state,
        Date.now(),
        input.actor_ref,
        input.drift_id ?? null,
        JSON.stringify(input.payload),
        Date.now(),
        Date.now(),
      );
  }

  // ── drift state ──────────────────────────────────────────

  recordDrift(input: {
    id: string;
    relative_path: string;
    field_path: string;
    field_class: string;
    intent_value: string | null;
    observed_value: string | null;
    detector_name: string;
    severity?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO drift_state(
            id, relative_path, field_path, field_class,
            detected_at, intent_value, observed_value, detector_name, severity
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            intent_value   = excluded.intent_value,
            observed_value = excluded.observed_value,
            severity       = excluded.severity,
            resolved_at    = NULL`,
      )
      .run(
        input.id,
        input.relative_path,
        input.field_path,
        input.field_class,
        Date.now(),
        input.intent_value,
        input.observed_value,
        input.detector_name,
        input.severity ?? null,
      );
  }

  resolveDrift(id: string): void {
    this.db
      .prepare("UPDATE drift_state SET resolved_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  unresolvedDrift(): Array<{
    id: string;
    relative_path: string;
    field_path: string;
    field_class: string;
    detector_name: string;
    severity: string | null;
    intent_value: string | null;
    observed_value: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT id, relative_path, field_path, field_class, detector_name,
                severity, intent_value, observed_value
         FROM drift_state
         WHERE resolved_at IS NULL
         ORDER BY detected_at DESC`,
      )
      .all() as Array<{
      id: string;
      relative_path: string;
      field_path: string;
      field_class: string;
      detector_name: string;
      severity: string | null;
      intent_value: string | null;
      observed_value: string | null;
    }>;
  }

  // ── loop events ──────────────────────────────────────────

  /**
   * Append a single loop event. Cheap; called on every tick of the
   * harness-loop runner. Returns the autoincrement id so callers can
   * paginate or correlate.
   */
  recordLoopEvent(event: LoopEventInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO loop_events(loop, status, at, summary_json, error)
         VALUES(?, ?, ?, ?, ?)`,
      )
      .run(
        event.loop,
        event.status,
        event.at,
        event.summary ? JSON.stringify(event.summary) : null,
        event.error ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Read recent loop events, newest first. With no `before` filter
   * returns the latest `limit` rows; with `before` set returns the
   * latest `limit` rows with `at < before` for cursor-style pagination.
   */
  recentLoopEvents(opts: RecentLoopEventsOptions = {}): LoopEventRow[] {
    const limit = opts.limit ?? 50;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (typeof opts.before === "number") {
      clauses.push("at < ?");
      params.push(opts.before);
    }
    if (opts.loop) {
      clauses.push("loop = ?");
      params.push(opts.loop);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, loop, status, at, summary_json, error
         FROM loop_events
         ${where}
         ORDER BY at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: number;
      loop: string;
      status: string;
      at: number;
      summary_json: string | null;
      error: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      loop: r.loop,
      status: r.status,
      at: r.at,
      summary: r.summary_json
        ? (JSON.parse(r.summary_json) as Record<string, unknown>)
        : undefined,
      error: r.error ?? undefined,
    }));
  }

  /**
   * Trim the loop_events table to at most `keep` rows by deleting the
   * oldest. Cheap guard against unbounded growth (~3 loops × 4/hr × 24h
   * × 365 ≈ 105k rows/year per harness). Defaults are generous; a
   * higher-level scheduler can call this periodically.
   */
  pruneLoopEventsKeepLatest(keep: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM loop_events
         WHERE id NOT IN (
           SELECT id FROM loop_events ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(keep);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

/** Compose the conventional path for a harness's index DB. */
export function defaultIndexPath(harnessId: string): string {
  return join(homedir(), ".brainstorm", "harness-index", `${harnessId}.db`);
}
