/**
 * Pipeline DAG Types — typed stages with dependency ordering.
 *
 * Each stage declares its dependencies. The executor runs stages in
 * topological order, with independent stages running in parallel.
 */

import type { CodeGraph } from "../graph.js";

export interface PipelineContext {
  projectPath: string;
  graph: CodeGraph;
  /** Stage outputs keyed by stage ID. */
  results: Map<string, unknown>;
  /** Progress callback. */
  onProgress?: (stageId: string, message: string) => void;
}

export interface PipelineStage {
  /** Unique stage identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** IDs of stages that must complete before this one runs. */
  dependsOn: string[];
  /** Execute the stage. Return value is stored in ctx.results[id]. */
  run(ctx: PipelineContext): Promise<unknown>;
}

export interface PipelineResult {
  stages: Array<{
    id: string;
    durationMs: number;
    success: boolean;
    error?: string;
  }>;
  totalDurationMs: number;
}
