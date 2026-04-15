/**
 * Cross-File Resolution Stage — matches call sites to definitions across files.
 *
 * After all files are parsed and inserted into the graph, this stage resolves
 * cross-file call edges: when function A in file X calls function B defined
 * in file Y, we create an edge in the nodes/edges tables linking them.
 *
 * Also resolves import edges: when file X imports from file Y, creates
 * an 'imports' edge between their file nodes.
 */

import type { PipelineStage, PipelineContext } from "../types.js";

export interface CrossFileResult {
  resolvedCalls: number;
  unresolvedCalls: number;
  importEdges: number;
}

export const crossFileStage: PipelineStage = {
  id: "cross-file",
  name: "Cross-File Resolution",
  dependsOn: ["graph-build"],

  async run(ctx: PipelineContext): Promise<CrossFileResult> {
    const db = ctx.graph.getDb();
    let resolvedCalls = 0;
    let unresolvedCalls = 0;
    let importEdges = 0;

    // Step 1: Resolve call edges across files.
    // For each call_edge where caller is in file A and callee is defined in file B,
    // create an edge in the edges table linking the caller node to the callee node.
    const callEdges = db
      .prepare(
        `
        SELECT ce.caller, ce.callee, ce.file, ce.line
        FROM call_edges ce
        WHERE ce.caller IS NOT NULL
      `,
      )
      .all() as Array<{
      caller: string;
      callee: string;
      file: string;
      line: number;
    }>;

    // Build a lookup: function name → node IDs (there may be multiple definitions)
    const nameToNodes = new Map<string, string[]>();
    const allNodes = db
      .prepare(
        "SELECT id, name FROM nodes WHERE kind IN ('function', 'method')",
      )
      .all() as Array<{ id: string; name: string }>;

    for (const node of allNodes) {
      const existing = nameToNodes.get(node.name) ?? [];
      existing.push(node.id);
      nameToNodes.set(node.name, existing);
    }

    // Also build caller name → node ID (for qualified names like "Class.method")
    const callerToNode = new Map<string, string>();
    for (const node of allNodes) {
      callerToNode.set(node.name, node.id);
    }

    const insertEdge = db.prepare(
      "INSERT OR IGNORE INTO edges (source_id, target_id, kind, metadata_json) VALUES (?, ?, 'calls', ?)",
    );

    // Deduplicate: avoid inserting the same edge twice
    const existingEdges = new Set<string>();
    const existing = db
      .prepare("SELECT source_id, target_id FROM edges WHERE kind = 'calls'")
      .all() as Array<{ source_id: string; target_id: string }>;
    for (const e of existing) {
      existingEdges.add(`${e.source_id}→${e.target_id}`);
    }

    const tx = db.transaction(() => {
      for (const edge of callEdges) {
        const callerNodeIds = nameToNodes.get(edge.caller);
        const calleeNodeIds = nameToNodes.get(edge.callee);

        if (!callerNodeIds || !calleeNodeIds) {
          unresolvedCalls++;
          continue;
        }

        // Connect every caller definition to every callee definition
        // (name-based resolution — ambiguous but correct for most codebases)
        for (const sourceId of callerNodeIds) {
          for (const targetId of calleeNodeIds) {
            if (sourceId === targetId) continue; // skip self-calls
            const key = `${sourceId}→${targetId}`;
            if (existingEdges.has(key)) continue;
            existingEdges.add(key);

            insertEdge.run(
              sourceId,
              targetId,
              JSON.stringify({ file: edge.file, line: edge.line }),
            );
            resolvedCalls++;
          }
        }
      }
    });
    tx();

    // Step 2: Resolve import edges between file nodes.
    const imports = db
      .prepare("SELECT file, source FROM imports")
      .all() as Array<{ file: string; source: string }>;

    const fileNodes = new Map<string, string>();
    const fileNodeRows = db
      .prepare("SELECT id, file FROM nodes WHERE kind = 'file'")
      .all() as Array<{ id: string; file: string }>;
    for (const row of fileNodeRows) {
      fileNodes.set(row.file, row.id);
    }

    const insertImportEdge = db.prepare(
      "INSERT OR IGNORE INTO edges (source_id, target_id, kind, metadata_json) VALUES (?, ?, 'imports', NULL)",
    );

    const importTx = db.transaction(() => {
      for (const imp of imports) {
        const sourceFileNode = fileNodes.get(imp.file);
        if (!sourceFileNode) continue;

        // Try to find the target file node by matching the import source
        // to a known file path (heuristic: check if any file ends with the source path)
        for (const [filePath, nodeId] of fileNodes) {
          if (
            filePath !== imp.file &&
            filePath.includes(imp.source.replace(/\./g, "/"))
          ) {
            insertImportEdge.run(sourceFileNode, nodeId);
            importEdges++;
            break;
          }
        }
      }
    });
    importTx();

    ctx.onProgress?.(
      "cross-file",
      `Resolved ${resolvedCalls} cross-file calls, ${importEdges} import edges (${unresolvedCalls} unresolved)`,
    );

    return { resolvedCalls, unresolvedCalls, importEdges };
  },
};
