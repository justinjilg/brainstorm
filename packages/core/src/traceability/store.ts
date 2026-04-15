/**
 * Traceability Store — persists traced artifacts in SQLite.
 *
 * Stores all artifacts with their trace links in the project's brainstorm.db.
 * Enables queries like:
 *   - "What code changes implement REQ-brainstorm-042?"
 *   - "Which requirements have no tests?"
 *   - "Full trace chain from requirement to deployment"
 */

import type Database from "better-sqlite3";
import type { TracedArtifact, ArtifactType, TraceLink } from "./trace-id.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("traceability");

/**
 * Initialize the traceability tables.
 */
export function initTraceabilitySchema(db: Database.Database): void {
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS traced_artifacts (
      trace_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      file_path TEXT,
      metadata_json TEXT
    )
  `,
  ).run();

  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_artifacts_type ON traced_artifacts(type)",
  ).run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_artifacts_project ON traced_artifacts(project)",
  ).run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_artifacts_status ON traced_artifacts(status)",
  ).run();

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS trace_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      FOREIGN KEY (source_id) REFERENCES traced_artifacts(trace_id) ON DELETE CASCADE
    )
  `,
  ).run();

  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_links_source ON trace_links(source_id)",
  ).run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_links_target ON trace_links(target_id)",
  ).run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_links_target_source ON trace_links(target_id, source_id)",
  ).run();
}

/**
 * Save or update a traced artifact.
 */
export function saveArtifact(
  db: Database.Database,
  artifact: TracedArtifact,
): void {
  initTraceabilitySchema(db);

  db.prepare(
    `
    INSERT OR REPLACE INTO traced_artifacts
    (trace_id, type, project, title, description, status, author, created_at, updated_at, file_path, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    artifact.traceId,
    artifact.type,
    artifact.project,
    artifact.title,
    artifact.description,
    artifact.status,
    artifact.author,
    artifact.createdAt,
    artifact.updatedAt,
    artifact.filePath ?? null,
    JSON.stringify(artifact.metadata),
  );

  // Update links — delete old, insert new
  db.prepare("DELETE FROM trace_links WHERE source_id = ?").run(
    artifact.traceId,
  );
  const insertLink = db.prepare(
    "INSERT INTO trace_links (source_id, target_id, relation) VALUES (?, ?, ?)",
  );
  for (const link of artifact.links) {
    insertLink.run(artifact.traceId, link.targetId, link.relation);
  }
}

/**
 * Load a traced artifact by ID.
 */
export function loadArtifact(
  db: Database.Database,
  traceId: string,
): TracedArtifact | null {
  initTraceabilitySchema(db);

  const row = db
    .prepare("SELECT * FROM traced_artifacts WHERE trace_id = ?")
    .get(traceId) as any;
  if (!row) return null;

  const links = db
    .prepare("SELECT target_id, relation FROM trace_links WHERE source_id = ?")
    .all(traceId) as Array<{ target_id: string; relation: string }>;

  return {
    traceId: row.trace_id,
    type: row.type,
    project: row.project,
    title: row.title,
    description: row.description,
    status: row.status,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    filePath: row.file_path,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    links: links.map((l) => ({
      targetId: l.target_id,
      relation: l.relation as TraceLink["relation"],
    })),
  };
}

/**
 * List all artifacts of a given type.
 */
export function listArtifacts(
  db: Database.Database,
  opts?: { type?: ArtifactType; project?: string; status?: string },
): TracedArtifact[] {
  initTraceabilitySchema(db);

  let sql = "SELECT trace_id FROM traced_artifacts WHERE 1=1";
  const params: any[] = [];

  if (opts?.type) {
    sql += " AND type = ?";
    params.push(opts.type);
  }
  if (opts?.project) {
    sql += " AND project = ?";
    params.push(opts.project);
  }
  if (opts?.status) {
    sql += " AND status = ?";
    params.push(opts.status);
  }

  sql += " ORDER BY created_at DESC";

  const rows = db.prepare(sql).all(...params) as Array<{ trace_id: string }>;
  return rows.map((r) => loadArtifact(db, r.trace_id)!).filter(Boolean);
}

/**
 * Trace the full chain from an artifact to all its descendants.
 * Uses recursive CTE to follow trace links.
 */
export function traceChain(
  db: Database.Database,
  traceId: string,
  direction: "downstream" | "upstream" = "downstream",
): TracedArtifact[] {
  initTraceabilitySchema(db);

  // Depth-limited recursive CTE — prevents infinite recursion on circular refs
  const sql =
    direction === "downstream"
      ? `
      WITH RECURSIVE chain(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT target_id, c.depth + 1 FROM trace_links
        JOIN chain c ON c.id = trace_links.source_id
        WHERE c.depth < 50
      )
      SELECT DISTINCT id FROM chain WHERE id != ? LIMIT 500
    `
      : `
      WITH RECURSIVE chain(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT source_id, c.depth + 1 FROM trace_links
        JOIN chain c ON c.id = trace_links.target_id
        WHERE c.depth < 50
      )
      SELECT DISTINCT id FROM chain WHERE id != ? LIMIT 500
    `;

  const rows = db.prepare(sql).all(traceId, traceId) as Array<{ id: string }>;
  return rows.map((r) => loadArtifact(db, r.id)!).filter(Boolean);
}

/**
 * Find requirements with no tests (coverage gap analysis).
 */
export function findUntestedRequirements(
  db: Database.Database,
  project: string,
): TracedArtifact[] {
  initTraceabilitySchema(db);

  const rows = db
    .prepare(
      `
    SELECT a.trace_id FROM traced_artifacts a
    WHERE a.type = 'REQ' AND a.project = ? AND a.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM trace_links l
      JOIN traced_artifacts t ON t.trace_id = l.source_id
      WHERE l.target_id = a.trace_id AND t.type = 'TST'
    )
  `,
    )
    .all(project) as Array<{ trace_id: string }>;

  return rows.map((r) => loadArtifact(db, r.trace_id)!).filter(Boolean);
}

/**
 * Find code changes with no requirement trace (ungoverned changes).
 */
export function findUntracedChanges(
  db: Database.Database,
  project: string,
): TracedArtifact[] {
  initTraceabilitySchema(db);

  const rows = db
    .prepare(
      `
    SELECT a.trace_id FROM traced_artifacts a
    WHERE a.type = 'CHG' AND a.project = ? AND a.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM trace_links l
      WHERE l.source_id = a.trace_id
      AND l.relation IN ('implements', 'derives-from')
    )
  `,
    )
    .all(project) as Array<{ trace_id: string }>;

  return rows.map((r) => loadArtifact(db, r.trace_id)!).filter(Boolean);
}

/**
 * Get traceability coverage metrics.
 */
export function getCoverageMetrics(
  db: Database.Database,
  project: string,
): {
  requirements: { total: number; tested: number; untested: number };
  changes: { total: number; traced: number; untraced: number };
  designDecisions: number;
  testCount: number;
} {
  initTraceabilitySchema(db);

  const reqTotal =
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM traced_artifacts WHERE type = 'REQ' AND project = ? AND status = 'active'",
        )
        .get(project) as any
    )?.c ?? 0;

  const reqUntested = findUntestedRequirements(db, project).length;

  const chgTotal =
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM traced_artifacts WHERE type = 'CHG' AND project = ? AND status = 'active'",
        )
        .get(project) as any
    )?.c ?? 0;

  const chgUntraced = findUntracedChanges(db, project).length;

  const designCount =
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM traced_artifacts WHERE type = 'DES' AND project = ?",
        )
        .get(project) as any
    )?.c ?? 0;

  const testCount =
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM traced_artifacts WHERE type = 'TST' AND project = ?",
        )
        .get(project) as any
    )?.c ?? 0;

  return {
    requirements: {
      total: reqTotal,
      tested: reqTotal - reqUntested,
      untested: reqUntested,
    },
    changes: {
      total: chgTotal,
      traced: chgTotal - chgUntraced,
      untraced: chgUntraced,
    },
    designDecisions: designCount,
    testCount,
  };
}
