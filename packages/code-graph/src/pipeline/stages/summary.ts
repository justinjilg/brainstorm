/**
 * Summary Stage — aggregates graph statistics.
 */

import type { PipelineStage, PipelineContext } from "../types.js";
import type { ScanResult } from "./scan.js";
import type { ParseResult } from "./parse.js";
import type { GraphBuildResult } from "./graph-build.js";
import type { CrossFileResult } from "./cross-file.js";

export interface PipelineSummary {
  filesDiscovered: number;
  filesParsed: number;
  filesSkipped: number;
  parseErrors: number;
  nodes: number;
  edges: number;
  communities: number;
  crossFileCallsResolved: number;
  crossFileCallsUnresolved: number;
  languages: string[];
}

export const summaryStage: PipelineStage = {
  id: "summary",
  name: "Summary",
  dependsOn: ["graph-build", "cross-file", "communities"],

  async run(ctx: PipelineContext): Promise<PipelineSummary> {
    const scan = ctx.results.get("scan") as ScanResult | undefined;
    const parse = ctx.results.get("parse") as ParseResult | undefined;
    const graphBuild = ctx.results.get("graph-build") as
      | GraphBuildResult
      | undefined;
    const crossFile = ctx.results.get("cross-file") as
      | CrossFileResult
      | undefined;
    const stats = ctx.graph.extendedStats();

    // Detect which languages were actually parsed
    const langRows = ctx.graph
      .getDb()
      .prepare("SELECT DISTINCT language FROM nodes WHERE language IS NOT NULL")
      .all() as Array<{ language: string }>;

    const summary: PipelineSummary = {
      filesDiscovered: scan?.totalFiles ?? 0,
      filesParsed: parse?.parsed.length ?? 0,
      filesSkipped: parse?.skipped ?? 0,
      parseErrors: parse?.errors ?? 0,
      nodes: stats.nodes,
      edges: stats.graphEdges,
      communities: stats.communities,
      crossFileCallsResolved: crossFile?.resolvedCalls ?? 0,
      crossFileCallsUnresolved: crossFile?.unresolvedCalls ?? 0,
      languages: langRows.map((r) => r.language),
    };

    ctx.onProgress?.(
      "summary",
      `Graph: ${summary.nodes} nodes, ${summary.edges} edges across ${summary.languages.length} languages`,
    );

    return summary;
  },
};
