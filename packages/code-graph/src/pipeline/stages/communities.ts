/**
 * Communities Stage — runs Louvain community detection on the graph.
 *
 * Depends on graph-build (needs populated nodes/edges tables).
 * Writes community assignments to the communities table and
 * updates nodes with their community_id.
 */

import {
  detectCommunities,
  type DetectionResult,
} from "../../community/index.js";
import type { PipelineStage, PipelineContext } from "../types.js";

export const communitiesStage: PipelineStage = {
  id: "communities",
  name: "Community Detection",
  dependsOn: ["cross-file"],

  async run(ctx: PipelineContext): Promise<DetectionResult> {
    const result = detectCommunities(ctx.graph);

    ctx.onProgress?.(
      "communities",
      `Detected ${result.communities.length} communities across ${result.totalNodes} nodes (modularity: ${result.modularity.toFixed(3)})`,
    );

    return result;
  },
};
