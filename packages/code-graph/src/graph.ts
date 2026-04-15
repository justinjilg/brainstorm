/**
 * SQLite knowledge graph — stores parsed code as nodes + edges.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { ParsedFile } from "./parser.js";

export interface GraphOptions {
  dbPath?: string;
  projectPath?: string;
}

export class CodeGraph {
  private db: Database.Database;

  constructor(opts: GraphOptions = {}) {
    const dbPath = opts.dbPath ?? defaultDbPath(opts.projectPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        last_parsed INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS functions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT NOT NULL,
        exported INTEGER NOT NULL,
        async INTEGER NOT NULL,
        FOREIGN KEY (file) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
      CREATE INDEX IF NOT EXISTS idx_functions_file ON functions(file);

      CREATE TABLE IF NOT EXISTS classes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL,
        FOREIGN KEY (file) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_classes_name ON classes(name);

      CREATE TABLE IF NOT EXISTS methods (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        class_name TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        is_static INTEGER NOT NULL,
        is_async INTEGER NOT NULL,
        FOREIGN KEY (file) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_methods_name ON methods(name);
      CREATE INDEX IF NOT EXISTS idx_methods_class ON methods(class_name);

      CREATE TABLE IF NOT EXISTS imports (
        file TEXT NOT NULL,
        source TEXT NOT NULL,
        names_json TEXT NOT NULL,
        is_default INTEGER NOT NULL,
        FOREIGN KEY (file) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file);
      CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source);

      CREATE TABLE IF NOT EXISTS call_edges (
        caller TEXT,
        callee TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        FOREIGN KEY (file) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_edges_callee ON call_edges(callee);
      CREATE INDEX IF NOT EXISTS idx_edges_caller ON call_edges(caller);
      CREATE INDEX IF NOT EXISTS idx_edges_file ON call_edges(file);

      -- ── Enhanced Graph Schema (Phase 1, Feature 2) ──────────────────
      -- Generic node/edge tables for community detection, cross-file
      -- resolution, and recursive CTE-based graph traversal.

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        language TEXT,
        metadata_json TEXT,
        community_id TEXT,
        FOREIGN KEY (file) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_nodes_community ON nodes(community_id);

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);

      CREATE TABLE IF NOT EXISTS communities (
        id TEXT PRIMARY KEY,
        name TEXT,
        node_count INTEGER,
        complexity_score REAL,
        metadata_json TEXT
      );
    `);
  }

  upsertFile(parsed: ParsedFile): void {
    const now = Math.floor(Date.now() / 1000);

    const existing = this.db
      .prepare("SELECT content_hash FROM files WHERE path = ?")
      .get(parsed.file) as { content_hash: string } | undefined;
    if (existing?.content_hash === parsed.contentHash) {
      return;
    }

    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM files WHERE path = ?").run(parsed.file);

      this.db
        .prepare(
          "INSERT INTO files (path, content_hash, last_parsed) VALUES (?, ?, ?)",
        )
        .run(parsed.file, parsed.contentHash, now);

      const fnStmt = this.db.prepare(
        "INSERT INTO functions (id, name, file, start_line, end_line, signature, exported, async) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const fn of parsed.functions) {
        const id = hashId(`fn:${parsed.file}:${fn.name}:${fn.startLine}`);
        fnStmt.run(
          id,
          fn.name,
          fn.file,
          fn.startLine,
          fn.endLine,
          fn.signature,
          fn.isExported ? 1 : 0,
          fn.isAsync ? 1 : 0,
        );
      }

      const clsStmt = this.db.prepare(
        "INSERT INTO classes (id, name, file, start_line, end_line, exported) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const cls of parsed.classes) {
        const id = hashId(`cls:${parsed.file}:${cls.name}:${cls.startLine}`);
        clsStmt.run(
          id,
          cls.name,
          cls.file,
          cls.startLine,
          cls.endLine,
          cls.isExported ? 1 : 0,
        );
      }

      const methodStmt = this.db.prepare(
        "INSERT INTO methods (id, name, class_name, file, start_line, end_line, is_static, is_async) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const m of parsed.methods) {
        const id = hashId(
          `m:${parsed.file}:${m.className}:${m.name}:${m.startLine}`,
        );
        methodStmt.run(
          id,
          m.name,
          m.className,
          m.file,
          m.startLine,
          m.endLine,
          m.isStatic ? 1 : 0,
          m.isAsync ? 1 : 0,
        );
      }

      const impStmt = this.db.prepare(
        "INSERT INTO imports (file, source, names_json, is_default) VALUES (?, ?, ?, ?)",
      );
      for (const imp of parsed.imports) {
        impStmt.run(
          imp.file,
          imp.source,
          JSON.stringify(imp.names),
          imp.isDefault ? 1 : 0,
        );
      }

      const edgeStmt = this.db.prepare(
        "INSERT INTO call_edges (caller, callee, file, line) VALUES (?, ?, ?, ?)",
      );
      for (const call of parsed.callSites) {
        edgeStmt.run(call.callerName, call.calleeName, call.file, call.line);
      }

      // ── Dual-write to nodes/edges tables ──────────────────────────
      const language = parsed.language ?? "typescript";

      // Delete old nodes for this file (cascade deletes edges)
      this.db.prepare("DELETE FROM nodes WHERE file = ?").run(parsed.file);

      const nodeStmt = this.db.prepare(
        "INSERT OR REPLACE INTO nodes (id, kind, name, file, start_line, end_line, language, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const edgeGraphStmt = this.db.prepare(
        "INSERT INTO edges (source_id, target_id, kind, metadata_json) VALUES (?, ?, ?, ?)",
      );

      // Build a map of name → nodeId for edge creation
      const nameToNodeId = new Map<string, string>();

      for (const fn of parsed.functions) {
        const id = hashId(`fn:${parsed.file}:${fn.name}:${fn.startLine}`);
        nodeStmt.run(
          id,
          "function",
          fn.name,
          fn.file,
          fn.startLine,
          fn.endLine,
          language,
          JSON.stringify({
            signature: fn.signature,
            exported: fn.isExported,
            async: fn.isAsync,
          }),
        );
        nameToNodeId.set(fn.name, id);
      }
      for (const cls of parsed.classes) {
        const id = hashId(`cls:${parsed.file}:${cls.name}:${cls.startLine}`);
        nodeStmt.run(
          id,
          "class",
          cls.name,
          cls.file,
          cls.startLine,
          cls.endLine,
          language,
          JSON.stringify({ exported: cls.isExported }),
        );
        nameToNodeId.set(cls.name, id);
      }
      for (const m of parsed.methods) {
        const id = hashId(
          `m:${parsed.file}:${m.className}:${m.name}:${m.startLine}`,
        );
        const qualifiedName = `${m.className}.${m.name}`;
        nodeStmt.run(
          id,
          "method",
          qualifiedName,
          m.file,
          m.startLine,
          m.endLine,
          language,
          JSON.stringify({
            className: m.className,
            static: m.isStatic,
            async: m.isAsync,
          }),
        );
        nameToNodeId.set(qualifiedName, id);
      }

      // Create call edges in the new graph (only for intra-file edges where both sides are known)
      for (const call of parsed.callSites) {
        if (!call.callerName) continue;
        const sourceId = nameToNodeId.get(call.callerName);
        if (!sourceId) continue;
        const targetId = nameToNodeId.get(call.calleeName);
        if (targetId) {
          edgeGraphStmt.run(
            sourceId,
            targetId,
            "calls",
            JSON.stringify({ file: call.file, line: call.line }),
          );
        }
      }

      // Create import edges
      for (const imp of parsed.imports) {
        // File-level import edge: we create a file node and connect it
        const fileNodeId = hashId(`file:${parsed.file}`);
        nodeStmt.run(
          fileNodeId,
          "file",
          parsed.file,
          parsed.file,
          null,
          null,
          language,
          null,
        );
        // Edge: file imports module (target is the source path string, not a node)
        // These cross-file edges get resolved in the cross-file pipeline stage
      }
    });
    tx();
  }

  findCallers(
    functionName: string,
    opts: { limit?: number } = {},
  ): Array<{ caller: string | null; file: string; line: number }> {
    const limit = opts.limit ?? 50;
    return this.db
      .prepare(
        "SELECT caller, file, line FROM call_edges WHERE callee = ? ORDER BY file, line LIMIT ?",
      )
      .all(functionName, limit) as any[];
  }

  findCallees(
    callerName: string,
    opts: { limit?: number } = {},
  ): Array<{ callee: string; file: string; line: number }> {
    const limit = opts.limit ?? 50;
    return this.db
      .prepare(
        "SELECT callee, file, line FROM call_edges WHERE caller = ? ORDER BY file, line LIMIT ?",
      )
      .all(callerName, limit) as any[];
  }

  findDefinition(name: string): Array<any> {
    const results: any[] = [];
    const fns = this.db
      .prepare(
        "SELECT name, file, start_line AS startLine, signature FROM functions WHERE name = ?",
      )
      .all(name) as any[];
    for (const f of fns) results.push({ kind: "function", ...f });

    const methods = this.db
      .prepare(
        "SELECT name, class_name AS className, file, start_line AS startLine FROM methods WHERE name = ?",
      )
      .all(name) as any[];
    for (const m of methods) results.push({ kind: "method", ...m });

    const classes = this.db
      .prepare(
        "SELECT name, file, start_line AS startLine FROM classes WHERE name = ?",
      )
      .all(name) as any[];
    for (const c of classes) results.push({ kind: "class", ...c });

    return results;
  }

  impactAnalysis(
    functionName: string,
    maxDepth = 3,
  ): Array<{ name: string; depth: number; file: string }> {
    const visited = new Set<string>();
    const result: Array<{ name: string; depth: number; file: string }> = [];
    const queue: Array<{ name: string; depth: number }> = [
      { name: functionName, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.name)) continue;
      visited.add(current.name);
      if (current.depth > 0 && current.depth <= maxDepth) {
        const defs = this.findDefinition(current.name);
        const file = defs[0]?.file ?? "(unknown)";
        result.push({ name: current.name, depth: current.depth, file });
      }
      if (current.depth < maxDepth) {
        const callers = this.findCallers(current.name, { limit: 20 });
        for (const c of callers) {
          // Skip self-calls (recursive functions) to avoid infinite loops.
          // For null callers (call site at module top-level or inside a node
          // type the parser doesn't recognize as a function), record the
          // file as a leaf impact site so we don't lose the signal entirely.
          if (!c.caller) {
            const fileLeafKey = `${c.file}#module`;
            if (!visited.has(fileLeafKey)) {
              visited.add(fileLeafKey);
              if (current.depth + 1 <= maxDepth) {
                result.push({
                  name: "(module-level call site)",
                  depth: current.depth + 1,
                  file: c.file,
                });
              }
            }
            continue;
          }
          if (c.caller === current.name) continue; // self-recursion
          if (!visited.has(c.caller)) {
            queue.push({ name: c.caller, depth: current.depth + 1 });
          }
        }
      }
    }
    return result;
  }

  stats(): {
    files: number;
    functions: number;
    classes: number;
    methods: number;
    callEdges: number;
  } {
    return {
      files: (this.db.prepare("SELECT COUNT(*) AS c FROM files").get() as any)
        .c,
      functions: (
        this.db.prepare("SELECT COUNT(*) AS c FROM functions").get() as any
      ).c,
      classes: (
        this.db.prepare("SELECT COUNT(*) AS c FROM classes").get() as any
      ).c,
      methods: (
        this.db.prepare("SELECT COUNT(*) AS c FROM methods").get() as any
      ).c,
      callEdges: (
        this.db.prepare("SELECT COUNT(*) AS c FROM call_edges").get() as any
      ).c,
    };
  }

  // ── Enhanced Graph Traversal (recursive CTEs) ─────────────────

  /**
   * Find all transitive callers of a node using recursive CTE.
   * More powerful than the BFS impactAnalysis — uses the nodes/edges tables.
   */
  transitiveCallers(
    nodeId: string,
    maxDepth = 5,
  ): Array<{ id: string; name: string; file: string; depth: number }> {
    return this.db
      .prepare(
        `
      WITH RECURSIVE callers(id, name, file, depth) AS (
        SELECT n.id, n.name, n.file, 0
        FROM nodes n WHERE n.id = ?
        UNION
        SELECT n2.id, n2.name, n2.file, c.depth + 1
        FROM callers c
        JOIN edges e ON e.target_id = c.id AND e.kind = 'calls'
        JOIN nodes n2 ON n2.id = e.source_id
        WHERE c.depth < ?
      )
      SELECT id, name, file, depth FROM callers
      WHERE depth > 0
      ORDER BY depth, name
    `,
      )
      .all(nodeId, maxDepth) as any[];
  }

  /**
   * Find all transitive callees of a node using recursive CTE.
   */
  transitiveCallees(
    nodeId: string,
    maxDepth = 5,
  ): Array<{ id: string; name: string; file: string; depth: number }> {
    return this.db
      .prepare(
        `
      WITH RECURSIVE callees(id, name, file, depth) AS (
        SELECT n.id, n.name, n.file, 0
        FROM nodes n WHERE n.id = ?
        UNION
        SELECT n2.id, n2.name, n2.file, c.depth + 1
        FROM callees c
        JOIN edges e ON e.source_id = c.id AND e.kind = 'calls'
        JOIN nodes n2 ON n2.id = e.target_id
        WHERE c.depth < ?
      )
      SELECT id, name, file, depth FROM callees
      WHERE depth > 0
      ORDER BY depth, name
    `,
      )
      .all(nodeId, maxDepth) as any[];
  }

  /**
   * Find shortest path between two nodes using bidirectional BFS via CTE.
   * Returns the node IDs along the path, or null if no path exists.
   */
  shortestPath(fromId: string, toId: string, maxDepth = 10): string[] | null {
    // Use forward traversal and check if target is reached
    const rows = this.db
      .prepare(
        `
      WITH RECURSIVE paths(id, path, depth) AS (
        SELECT ?, ?, 0
        UNION
        SELECT e.target_id, p.path || ',' || e.target_id, p.depth + 1
        FROM paths p
        JOIN edges e ON e.source_id = p.id
        WHERE p.depth < ? AND p.id != ?
      )
      SELECT path FROM paths WHERE id = ? LIMIT 1
    `,
      )
      .get(fromId, fromId, maxDepth, toId, toId) as
      | { path: string }
      | undefined;

    return rows ? rows.path.split(",") : null;
  }

  /**
   * Find all nodes in the same connected component.
   */
  connectedComponent(nodeId: string): string[] {
    const rows = this.db
      .prepare(
        `
      WITH RECURSIVE component(id) AS (
        SELECT ?
        UNION
        SELECT CASE
          WHEN e.source_id = c.id THEN e.target_id
          ELSE e.source_id
        END
        FROM component c
        JOIN edges e ON e.source_id = c.id OR e.target_id = c.id
      )
      SELECT DISTINCT id FROM component
    `,
      )
      .all(nodeId) as Array<{ id: string }>;

    return rows.map((r) => r.id);
  }

  /**
   * Get all communities.
   */
  getCommunities(): Array<{
    id: string;
    name: string | null;
    nodeCount: number;
    complexityScore: number | null;
  }> {
    return this.db
      .prepare(
        "SELECT id, name, node_count AS nodeCount, complexity_score AS complexityScore FROM communities",
      )
      .all() as any[];
  }

  /**
   * Get all nodes belonging to a community.
   */
  getNodesInCommunity(communityId: string): Array<{
    id: string;
    kind: string;
    name: string;
    file: string;
  }> {
    return this.db
      .prepare(
        "SELECT id, kind, name, file FROM nodes WHERE community_id = ? ORDER BY file, name",
      )
      .all(communityId) as any[];
  }

  /**
   * Find a node by name (searches the nodes table).
   */
  findNode(name: string): Array<{
    id: string;
    kind: string;
    name: string;
    file: string;
    startLine: number | null;
    communityId: string | null;
  }> {
    return this.db
      .prepare(
        "SELECT id, kind, name, file, start_line AS startLine, community_id AS communityId FROM nodes WHERE name = ?",
      )
      .all(name) as any[];
  }

  /**
   * Extended stats including the new tables.
   */
  extendedStats(): {
    files: number;
    functions: number;
    classes: number;
    methods: number;
    callEdges: number;
    nodes: number;
    graphEdges: number;
    communities: number;
  } {
    const base = this.stats();
    return {
      ...base,
      nodes: (this.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as any)
        .c,
      graphEdges: (
        this.db.prepare("SELECT COUNT(*) AS c FROM edges").get() as any
      ).c,
      communities: (
        this.db.prepare("SELECT COUNT(*) AS c FROM communities").get() as any
      ).c,
    };
  }

  /** Get the underlying database instance (for advanced queries). */
  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

function hashId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function defaultDbPath(projectPath?: string): string {
  if (!projectPath) {
    return join(homedir(), ".brainstorm", "code-graph.db");
  }
  const hash = createHash("sha256")
    .update(projectPath)
    .digest("hex")
    .slice(0, 16);
  return join(homedir(), ".brainstorm", "projects", hash, "code-graph.db");
}
