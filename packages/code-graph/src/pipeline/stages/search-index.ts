/**
 * Search Index Stage — builds the FTS5 full-text index for BM25 search.
 *
 * Depends on graph-build (needs populated nodes table).
 */

import { buildFTS5Index } from "../../search/bm25.js";
import type { PipelineStage, PipelineContext } from "../types.js";

export interface SearchIndexResult {
  documentsIndexed: number;
}

export const searchIndexStage: PipelineStage = {
  id: "search-index",
  name: "Search Index (BM25)",
  dependsOn: ["graph-build"],

  async run(ctx: PipelineContext): Promise<SearchIndexResult> {
    const db = ctx.graph.getDb();
    const documentsIndexed = buildFTS5Index(db);

    ctx.onProgress?.(
      "search-index",
      `Built FTS5 search index: ${documentsIndexed} documents`,
    );

    return { documentsIndexed };
  },
};
