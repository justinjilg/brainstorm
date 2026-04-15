/**
 * Pipeline DAG Executor — runs stages in topological order.
 *
 * Independent stages (no unresolved deps) run in parallel via Promise.all.
 * Failed stages mark their dependents as skipped.
 */

import type {
  PipelineStage,
  PipelineContext,
  PipelineResult,
} from "./types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("pipeline");

/**
 * Topological sort of stages by dependency order.
 * Returns stages grouped into levels — all stages in a level can run in parallel.
 */
export function topologicalLevels(stages: PipelineStage[]): PipelineStage[][] {
  const stageMap = new Map(stages.map((s) => [s.id, s]));
  const resolved = new Set<string>();
  const levels: PipelineStage[][] = [];
  const remaining = new Set(stages.map((s) => s.id));

  while (remaining.size > 0) {
    const level: PipelineStage[] = [];

    for (const id of remaining) {
      const stage = stageMap.get(id)!;
      const depsResolved = stage.dependsOn.every((d) => resolved.has(d));
      if (depsResolved) {
        level.push(stage);
      }
    }

    if (level.length === 0) {
      const unresolved = Array.from(remaining).join(", ");
      throw new Error(
        `Pipeline has circular dependencies or missing stages: ${unresolved}`,
      );
    }

    for (const s of level) {
      remaining.delete(s.id);
      resolved.add(s.id);
    }

    levels.push(level);
  }

  return levels;
}

/**
 * Execute a pipeline — runs stages in topological order with parallelism.
 */
export async function executePipeline(
  stages: PipelineStage[],
  ctx: PipelineContext,
): Promise<PipelineResult> {
  const levels = topologicalLevels(stages);
  const stageResults: PipelineResult["stages"] = [];
  const failed = new Set<string>();
  const totalStart = Date.now();

  for (const level of levels) {
    // Filter out stages whose dependencies failed
    const runnable = level.filter((s) =>
      s.dependsOn.every((d) => !failed.has(d)),
    );
    const skipped = level.filter((s) => s.dependsOn.some((d) => failed.has(d)));

    for (const s of skipped) {
      failed.add(s.id);
      stageResults.push({
        id: s.id,
        durationMs: 0,
        success: false,
        error: "Skipped — dependency failed",
      });
    }

    // Run all runnable stages in this level concurrently
    const promises = runnable.map(async (stage) => {
      const start = Date.now();
      ctx.onProgress?.(stage.id, `Running ${stage.name}...`);

      try {
        const output = await stage.run(ctx);
        ctx.results.set(stage.id, output);
        const durationMs = Date.now() - start;

        log.debug(
          { stage: stage.id, durationMs },
          `Stage ${stage.name} completed`,
        );

        stageResults.push({ id: stage.id, durationMs, success: true });
      } catch (err: any) {
        const durationMs = Date.now() - start;
        const error = err.message ?? String(err);
        failed.add(stage.id);

        log.error(
          { stage: stage.id, err, durationMs },
          `Stage ${stage.name} failed`,
        );

        stageResults.push({ id: stage.id, durationMs, success: false, error });
      }
    });

    await Promise.all(promises);
  }

  return {
    stages: stageResults,
    totalDurationMs: Date.now() - totalStart,
  };
}
