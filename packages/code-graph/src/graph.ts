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
          if (c.caller && !visited.has(c.caller)) {
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
