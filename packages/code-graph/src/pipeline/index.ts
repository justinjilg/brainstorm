/**
 * Default Pipeline — assembles the standard analysis pipeline.
 *
 * Stages: scan → parse → graph-build → cross-file → summary
 *
 * Communities and search-index stages will be added in Phase 2.
 */

export { executePipeline, topologicalLevels } from "./executor.js";
export type {
  PipelineStage,
  PipelineContext,
  PipelineResult,
} from "./types.js";
export type { ScanResult } from "./stages/scan.js";
export type { ParseResult } from "./stages/parse.js";
export type { GraphBuildResult } from "./stages/graph-build.js";
export type { CrossFileResult } from "./stages/cross-file.js";
export type { PipelineSummary } from "./stages/summary.js";

import { scanStage } from "./stages/scan.js";
import { parseStage } from "./stages/parse.js";
import { graphBuildStage } from "./stages/graph-build.js";
import { crossFileStage } from "./stages/cross-file.js";
import { communitiesStage } from "./stages/communities.js";
import { searchIndexStage } from "./stages/search-index.js";
import { summaryStage } from "./stages/summary.js";
import type { PipelineStage } from "./types.js";

/**
 * Create the default analysis pipeline.
 *
 * scan → parse → graph-build → [cross-file, search-index] → communities → summary
 * (cross-file and search-index run in parallel — both depend only on graph-build)
 */
export function createDefaultPipeline(): PipelineStage[] {
  return [
    scanStage,
    parseStage,
    graphBuildStage,
    crossFileStage,
    searchIndexStage,
    communitiesStage,
    summaryStage,
  ];
}
