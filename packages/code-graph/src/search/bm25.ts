/**
 * BM25 Search via SQLite FTS5.
 *
 * FTS5 has BM25 ranking built in. We populate a virtual table with
 * function/class/method content and query it with full-text search.
 */

import type Database from "better-sqlite3";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("bm25");

/**
 * Ensure the FTS5 virtual table exists.
 */
export function initFTS5(db: Database.Database): void {
  // SQLite FTS5 virtual table for full-text search with BM25 ranking
  db.prepare(
    `
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      node_id,
      file_path,
      symbol_name,
      kind,
      content,
      tokenize='porter unicode61'
    )
  `,
  ).run();
}

/**
 * Populate the FTS5 index from the nodes table.
 * Clears and rebuilds the entire index.
 */
export function buildFTS5Index(db: Database.Database): number {
  initFTS5(db);

  db.prepare("DELETE FROM search_fts").run();

  const nodes = db
    .prepare(
      `
    SELECT n.id, n.name, n.kind, n.file, n.start_line, n.end_line,
           n.metadata_json, n.community_id
    FROM nodes n
    WHERE n.kind != 'file'
  `,
    )
    .all() as Array<{
    id: string;
    name: string;
    kind: string;
    file: string;
    start_line: number | null;
    end_line: number | null;
    metadata_json: string | null;
  }>;

  const insert = db.prepare(
    "INSERT INTO search_fts (node_id, file_path, symbol_name, kind, content) VALUES (?, ?, ?, ?, ?)",
  );

  let indexed = 0;
  const tx = db.transaction(() => {
    for (const node of nodes) {
      const parts = [node.name];

      if (node.metadata_json) {
        try {
          const meta = JSON.parse(node.metadata_json);
          if (meta.signature) parts.push(meta.signature);
          if (meta.className) parts.push(meta.className);
        } catch {
          /* ignore bad JSON */
        }
      }

      parts.push(...node.file.split("/").filter((s) => s.length > 1));

      insert.run(node.id, node.file, node.name, node.kind, parts.join(" "));
      indexed++;
    }
  });
  tx();

  log.debug({ indexed }, "FTS5 index built");
  return indexed;
}

export interface BM25Result {
  nodeId: string;
  filePath: string;
  symbolName: string;
  kind: string;
  score: number;
}

/**
 * Search the FTS5 index with BM25 ranking.
 */
export function searchBM25(
  db: Database.Database,
  query: string,
  limit = 20,
): BM25Result[] {
  initFTS5(db);

  const safeQuery = query.replace(/['"(){}[\]^~*?:\\]/g, " ").trim();
  if (!safeQuery) return [];

  try {
    return db
      .prepare(
        `
      SELECT
        node_id AS nodeId,
        file_path AS filePath,
        symbol_name AS symbolName,
        kind,
        bm25(search_fts) AS score
      FROM search_fts
      WHERE search_fts MATCH ?
      ORDER BY bm25(search_fts)
      LIMIT ?
    `,
      )
      .all(safeQuery, limit) as BM25Result[];
  } catch {
    // FTS5 query syntax error — fallback to LIKE
    return db
      .prepare(
        `
      SELECT
        node_id AS nodeId,
        file_path AS filePath,
        symbol_name AS symbolName,
        kind,
        0.0 AS score
      FROM search_fts
      WHERE content LIKE ?
      LIMIT ?
    `,
      )
      .all(`%${safeQuery}%`, limit) as BM25Result[];
  }
}
