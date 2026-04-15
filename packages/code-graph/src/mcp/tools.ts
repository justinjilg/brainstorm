/**
 * 16 MCP Tool Definitions for Code Intelligence.
 *
 * Each tool queries the CodeGraph and returns structured results.
 * Tools are registered with the MCP server via registerCodeIntelTools().
 */

import { z } from "zod";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { CodeGraph } from "../graph.js";
import { hybridSearch } from "../search/hybrid.js";

type McpServer = {
  tool(
    name: string,
    description: string,
    schema: Record<string, any>,
    handler: (params: any) => Promise<any>,
  ): void;
};

function textResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Register all 16 code intelligence tools on an MCP server instance.
 */
export function registerCodeIntelTools(
  server: McpServer,
  graph: CodeGraph,
  projectPath: string,
): void {
  // ── 1. code_query — Find definitions by name ───────────────────
  server.tool(
    "code_query",
    "Find function, class, or method definitions by name. Returns file path, line number, and kind.",
    { name: z.string().describe("Symbol name to search for") },
    async ({ name }) => {
      const results = graph.findDefinition(name);
      const nodeResults = graph.findNode(name);
      return textResult({
        definitions: results,
        graphNodes: nodeResults,
        count: results.length,
      });
    },
  );

  // ── 2. code_context — 360-degree symbol view ───────────────────
  server.tool(
    "code_context",
    "Get complete context for a symbol: its source code, callers, callees, and community membership.",
    {
      name: z.string().describe("Symbol name"),
      linesAround: z
        .number()
        .optional()
        .describe("Lines of context around the definition (default 5)"),
    },
    async ({ name, linesAround }) => {
      const padding = linesAround ?? 5;
      const defs = graph.findDefinition(name);
      if (defs.length === 0)
        return textResult({ error: `Symbol '${name}' not found` });

      const def = defs[0];
      let sourceSnippet = "";
      try {
        const lines = readFileSync(def.file, "utf-8").split("\n");
        const start = Math.max(0, (def.startLine ?? 1) - 1 - padding);
        const end = Math.min(
          lines.length,
          (def.startLine ?? 1) - 1 + padding + 10,
        );
        sourceSnippet = lines
          .slice(start, end)
          .map((l, i) => `${start + i + 1}: ${l}`)
          .join("\n");
      } catch {
        /* file may have moved */
      }

      const callers = graph.findCallers(name, { limit: 20 });
      const callees = graph.findCallees(name, { limit: 20 });
      const nodes = graph.findNode(name);
      const communityId = nodes[0]?.communityId;

      return textResult({
        definition: def,
        source: sourceSnippet,
        callers,
        callees,
        community: communityId ?? null,
        callerCount: callers.length,
        calleeCount: callees.length,
      });
    },
  );

  // ── 3. code_callers — Who calls this? ──────────────────────────
  server.tool(
    "code_callers",
    "Find all callers of a function, optionally with transitive depth.",
    {
      name: z.string().describe("Function name"),
      depth: z
        .number()
        .optional()
        .describe("Transitive depth (default 1, max 5)"),
    },
    async ({ name, depth }) => {
      if (depth && depth > 1) {
        const nodes = graph.findNode(name);
        if (nodes.length > 0) {
          const transitive = graph.transitiveCallers(
            nodes[0].id,
            Math.min(depth, 5),
          );
          return textResult({ callers: transitive, transitive: true, depth });
        }
      }
      const callers = graph.findCallers(name, { limit: 50 });
      return textResult({ callers, transitive: false });
    },
  );

  // ── 4. code_callees — What does this call? ─────────────────────
  server.tool(
    "code_callees",
    "Find all functions called by a given function, optionally with transitive depth.",
    {
      name: z.string().describe("Function name"),
      depth: z
        .number()
        .optional()
        .describe("Transitive depth (default 1, max 5)"),
    },
    async ({ name, depth }) => {
      if (depth && depth > 1) {
        const nodes = graph.findNode(name);
        if (nodes.length > 0) {
          const transitive = graph.transitiveCallees(
            nodes[0].id,
            Math.min(depth, 5),
          );
          return textResult({ callees: transitive, transitive: true, depth });
        }
      }
      const callees = graph.findCallees(name, { limit: 50 });
      return textResult({ callees, transitive: false });
    },
  );

  // ── 5. code_impact — Blast radius analysis ─────────────────────
  server.tool(
    "code_impact",
    "Analyze the blast radius of changing a function. Shows all transitively affected callers grouped by depth.",
    {
      name: z.string().describe("Function name to analyze"),
      maxDepth: z
        .number()
        .optional()
        .describe("Maximum traversal depth (default 3)"),
    },
    async ({ name, maxDepth }) => {
      const impact = graph.impactAnalysis(name, maxDepth ?? 3);

      // Group by depth for readability
      const byDepth: Record<number, Array<{ name: string; file: string }>> = {};
      for (const item of impact) {
        if (!byDepth[item.depth]) byDepth[item.depth] = [];
        byDepth[item.depth].push({ name: item.name, file: item.file });
      }

      return textResult({
        function: name,
        totalAffected: impact.length,
        byDepth,
        maxDepthReached: Math.max(0, ...impact.map((i) => i.depth)),
      });
    },
  );

  // ── 6. code_search — Hybrid search (BM25 + name matching + RRF) ─
  server.tool(
    "code_search",
    "Search the codebase using hybrid BM25 + name matching with Reciprocal Rank Fusion. Returns ranked results with community membership.",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ query, limit }) => {
      const results = hybridSearch(graph.getDb(), query, { topK: limit ?? 20 });

      return textResult({
        query,
        results: results.map((r) => ({
          name: r.name,
          kind: r.kind,
          file: r.file,
          communityId: r.communityId,
          fusedScore: r.fusedScore,
          bm25Score: r.bm25Score,
        })),
        count: results.length,
        searchEngine: "hybrid-bm25-rrf",
      });
    },
  );

  // ── 7. code_detect_changes — Git diff → affected symbols ───────
  server.tool(
    "code_detect_changes",
    "Map recent git changes to affected symbols and their callers. Pre-commit risk analysis.",
    {
      since: z
        .string()
        .optional()
        .describe("Git ref to diff against (default HEAD~1)"),
    },
    async ({ since }) => {
      const ref = since ?? "HEAD~1";
      let diffOutput: string;
      try {
        diffOutput = execFileSync("git", ["diff", "--name-only", ref], {
          cwd: projectPath,
          encoding: "utf-8",
          timeout: 10000,
        });
      } catch {
        return textResult({ error: "Failed to run git diff", ref });
      }

      const changedFiles = diffOutput.trim().split("\n").filter(Boolean);
      const db = graph.getDb();

      const affectedSymbols: Array<{
        name: string;
        kind: string;
        file: string;
        callerCount: number;
      }> = [];
      for (const file of changedFiles) {
        const fullPath = `${projectPath}/${file}`;
        const nodes = db
          .prepare(
            "SELECT id, kind, name, file FROM nodes WHERE file = ? OR file = ?",
          )
          .all(fullPath, file) as any[];

        for (const node of nodes) {
          const callers = graph.findCallers(node.name, { limit: 100 });
          affectedSymbols.push({
            name: node.name,
            kind: node.kind,
            file: node.file,
            callerCount: callers.length,
          });
        }
      }

      // Sort by risk (most callers = highest risk)
      affectedSymbols.sort((a, b) => b.callerCount - a.callerCount);

      return textResult({
        ref,
        changedFiles,
        affectedSymbols,
        highRisk: affectedSymbols.filter((s) => s.callerCount > 5),
      });
    },
  );

  // ── 8. code_rename — Safe rename analysis ──────────────────────
  server.tool(
    "code_rename",
    "Find all references to a symbol for safe renaming. Shows every file and line that needs to change.",
    { name: z.string().describe("Symbol name to rename") },
    async ({ name }) => {
      const definitions = graph.findDefinition(name);
      const callers = graph.findCallers(name, { limit: 100 });
      const db = graph.getDb();

      // Also find imports that reference this name
      const importRefs = db
        .prepare("SELECT file, source FROM imports WHERE names_json LIKE ?")
        .all(`%"${name}"%`) as Array<{ file: string; source: string }>;

      return textResult({
        symbol: name,
        definitions,
        callSites: callers,
        importReferences: importRefs,
        totalReferences:
          definitions.length + callers.length + importRefs.length,
      });
    },
  );

  // ── 9. code_graph_query — Raw SQL with safeguards ──────────────
  server.tool(
    "code_graph_query",
    "Run a read-only SQL query against the knowledge graph. Tables: nodes, edges, communities, functions, classes, methods, imports, call_edges, files.",
    {
      sql: z.string().describe("SQL query (SELECT only)"),
      params: z
        .array(z.union([z.string(), z.number()]))
        .optional()
        .describe("Query parameters"),
    },
    async ({ sql, params }) => {
      // Safety: only allow SELECT
      const normalized = sql.trim().toLowerCase();
      if (!normalized.startsWith("select")) {
        return textResult({ error: "Only SELECT queries are allowed" });
      }
      if (/\b(drop|delete|update|insert|alter|create)\b/i.test(sql)) {
        return textResult({ error: "Mutation queries are not allowed" });
      }

      try {
        const db = graph.getDb();
        const results = params?.length
          ? db.prepare(sql).all(...params)
          : db.prepare(sql).all();
        return textResult({ results, count: (results as any[]).length });
      } catch (err: any) {
        return textResult({ error: err.message });
      }
    },
  );

  // ── 10. code_communities — List all communities ────────────────
  server.tool(
    "code_communities",
    "List all detected code communities (sectors). Each community is a cluster of related code.",
    {},
    async () => {
      const communities = graph.getCommunities();
      return textResult({ communities, count: communities.length });
    },
  );

  // ── 11. code_community_detail — Deep view of one community ─────
  server.tool(
    "code_community_detail",
    "Get detailed view of a community: its nodes, internal edges, complexity, and key functions.",
    { communityId: z.string().describe("Community ID") },
    async ({ communityId }) => {
      const nodes = graph.getNodesInCommunity(communityId);
      const db = graph.getDb();

      const community = db
        .prepare("SELECT * FROM communities WHERE id = ?")
        .get(communityId) as any;

      // Get internal edges (both endpoints in this community)
      const nodeIds = new Set(nodes.map((n) => n.id));
      const allEdges = db
        .prepare(
          `
        SELECT source_id, target_id, kind FROM edges
        WHERE source_id IN (${nodes.map(() => "?").join(",")})
      `,
        )
        .all(...nodes.map((n) => n.id)) as any[];

      const internalEdges = allEdges.filter((e: any) =>
        nodeIds.has(e.target_id),
      );
      const externalEdges = allEdges.filter(
        (e: any) => !nodeIds.has(e.target_id),
      );

      return textResult({
        community,
        nodes,
        nodeCount: nodes.length,
        internalEdges: internalEdges.length,
        externalEdges: externalEdges.length,
        cohesion:
          internalEdges.length /
          Math.max(1, internalEdges.length + externalEdges.length),
        files: [...new Set(nodes.map((n) => n.file))],
      });
    },
  );

  // ── 12. code_file_summary — File's role in the graph ───────────
  server.tool(
    "code_file_summary",
    "Summarize a file's role in the codebase: its functions, classes, imports, exports, and connections.",
    { file: z.string().describe("File path (relative or absolute)") },
    async ({ file }) => {
      const db = graph.getDb();

      const functions = db
        .prepare(
          "SELECT name, start_line, signature, exported FROM functions WHERE file = ? OR file LIKE ?",
        )
        .all(file, `%${file}`) as any[];

      const classes = db
        .prepare(
          "SELECT name, start_line, exported FROM classes WHERE file = ? OR file LIKE ?",
        )
        .all(file, `%${file}`) as any[];

      const methods = db
        .prepare(
          "SELECT name, class_name, start_line FROM methods WHERE file = ? OR file LIKE ?",
        )
        .all(file, `%${file}`) as any[];

      const imports = db
        .prepare(
          "SELECT source, names_json FROM imports WHERE file = ? OR file LIKE ?",
        )
        .all(file, `%${file}`) as any[];

      const incomingCalls = db
        .prepare(
          "SELECT DISTINCT caller FROM call_edges WHERE file != ? AND callee IN (SELECT name FROM functions WHERE file = ? OR file LIKE ?)",
        )
        .all(file, file, `%${file}`) as any[];

      return textResult({
        file,
        functions: functions.map((f: any) => ({
          name: f.name,
          line: f.start_line,
          exported: !!f.exported,
        })),
        classes: classes.map((c: any) => ({
          name: c.name,
          line: c.start_line,
          exported: !!c.exported,
        })),
        methods: methods.map((m: any) => ({
          name: m.name,
          class: m.class_name,
          line: m.start_line,
        })),
        imports: imports.map((i: any) => ({
          source: i.source,
          names: JSON.parse(i.names_json),
        })),
        incomingCallers: incomingCalls.length,
        totalSymbols: functions.length + classes.length + methods.length,
      });
    },
  );

  // ── 13. code_dependencies — Transitive import chain ────────────
  server.tool(
    "code_dependencies",
    "Trace the dependency chain for a file or module. Shows what it imports and what imports it.",
    { file: z.string().describe("File path") },
    async ({ file }) => {
      const db = graph.getDb();

      const directImports = db
        .prepare(
          "SELECT source, names_json FROM imports WHERE file = ? OR file LIKE ?",
        )
        .all(file, `%${file}`) as any[];

      const importedBy = db
        .prepare("SELECT file, names_json FROM imports WHERE source LIKE ?")
        .all(`%${file.replace(/\.[^.]+$/, "")}%`) as any[];

      return textResult({
        file,
        imports: directImports.map((i: any) => ({
          source: i.source,
          names: JSON.parse(i.names_json),
        })),
        importedBy: importedBy.map((i: any) => ({
          file: i.file,
          names: JSON.parse(i.names_json),
        })),
        importCount: directImports.length,
        importedByCount: importedBy.length,
      });
    },
  );

  // ── 14. code_hotspots — Most complex/connected nodes ───────────
  server.tool(
    "code_hotspots",
    "Find the most complex and highly-connected functions in the codebase. These are the riskiest to change.",
    { limit: z.number().optional().describe("Max results (default 20)") },
    async ({ limit }) => {
      const max = limit ?? 20;
      const db = graph.getDb();

      // Rank by number of incoming call edges (most depended-on functions)
      const hotspots = db
        .prepare(
          `
        SELECT
          ce.callee AS name,
          COUNT(*) AS callerCount,
          f.file,
          f.start_line AS startLine,
          f.end_line AS endLine,
          (f.end_line - f.start_line) AS lineCount
        FROM call_edges ce
        JOIN functions f ON f.name = ce.callee
        GROUP BY ce.callee, f.file
        ORDER BY callerCount DESC, lineCount DESC
        LIMIT ?
      `,
        )
        .all(max) as any[];

      return textResult({
        hotspots: hotspots.map((h: any, i: number) => ({
          rank: i + 1,
          name: h.name,
          file: h.file,
          callerCount: h.callerCount,
          lineCount: h.lineCount,
          startLine: h.startLine,
        })),
        count: hotspots.length,
      });
    },
  );

  // ── 15. code_stats — Graph statistics ──────────────────────────
  server.tool(
    "code_stats",
    "Get comprehensive statistics about the indexed codebase: file count, function count, edge count, languages, etc.",
    {},
    async () => {
      const stats = graph.extendedStats();
      const db = graph.getDb();

      const languages = db
        .prepare(
          "SELECT language, COUNT(*) AS count FROM nodes WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC",
        )
        .all() as any[];

      const edgeKinds = db
        .prepare(
          "SELECT kind, COUNT(*) AS count FROM edges GROUP BY kind ORDER BY count DESC",
        )
        .all() as any[];

      return textResult({
        ...stats,
        languages,
        edgeKinds,
      });
    },
  );

  // ── 16. code_reindex — Trigger incremental re-index ────────────
  server.tool(
    "code_reindex",
    "Trigger an incremental re-index of the codebase. Only re-parses files that changed since last index.",
    {},
    async () => {
      // Import dynamically to avoid circular deps at registration time
      const { initializeAdapters } = await import("../languages/registry.js");
      const { executePipeline, createDefaultPipeline } =
        await import("../pipeline/index.js");

      await initializeAdapters();
      const pipeline = createDefaultPipeline();
      const result = await executePipeline(pipeline, {
        projectPath,
        graph,
        results: new Map(),
      });

      const summary = result.stages.find((s) => s.id === "summary");
      return textResult({
        success: result.stages.every((s) => s.success),
        totalDurationMs: result.totalDurationMs,
        stages: result.stages.map((s) => ({
          id: s.id,
          durationMs: s.durationMs,
          success: s.success,
        })),
      });
    },
  );
}
