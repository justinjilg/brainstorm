/**
 * Graph Build Stage — populates the SQLite graph from parsed files.
 *
 * Upserts all parsed files into both the legacy tables (functions, classes,
 * methods, imports, call_edges) and the new tables (nodes, edges) via
 * CodeGraph.upsertFile().
 */

import type { PipelineStage, PipelineContext } from "../types.js";
import type { ParseResult } from "./parse.js";

export interface GraphBuildResult {
  filesInserted: number;
  nodesCreated: number;
  edgesCreated: number;
}

export const graphBuildStage: PipelineStage = {
  id: "graph-build",
  name: "Knowledge Graph Build",
  dependsOn: ["parse"],

  async run(ctx: PipelineContext): Promise<GraphBuildResult> {
    const parseResult = ctx.results.get("parse") as ParseResult;
    if (!parseResult) throw new Error("parse stage output missing");

    const statsBefore = ctx.graph.extendedStats();

    for (const parsed of parseResult.parsed) {
      ctx.graph.upsertFile(parsed);
    }

    const statsAfter = ctx.graph.extendedStats();

    const result: GraphBuildResult = {
      filesInserted: parseResult.parsed.length,
      nodesCreated: statsAfter.nodes - statsBefore.nodes,
      edgesCreated: statsAfter.graphEdges - statsBefore.graphEdges,
    };

    ctx.onProgress?.(
      "graph-build",
      `Built graph: ${result.nodesCreated} nodes, ${result.edgesCreated} edges`,
    );

    return result;
  },
};
