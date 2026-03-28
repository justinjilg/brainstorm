/**
 * Aggregator — formats orchestration results into a unified summary.
 */

import type { OrchestrationRun, OrchestrationTask } from "@brainstorm/shared";

export interface AggregatedResult {
  summary: string;
  totalCost: number;
  projectCount: number;
  successCount: number;
  failureCount: number;
  perProject: Array<{
    name: string;
    status: string;
    summary: string;
    cost: number;
  }>;
}

/**
 * Aggregate orchestration results into a readable summary.
 */
export function aggregateResults(
  run: OrchestrationRun,
  tasks: OrchestrationTask[],
  projectNames: Map<string, string>,
): AggregatedResult {
  const perProject = tasks.map((t) => ({
    name: projectNames.get(t.projectId) ?? t.projectId.slice(0, 8),
    status: t.status,
    summary: t.resultSummary ?? "No output",
    cost: t.cost,
  }));

  const successCount = tasks.filter((t) => t.status === "completed").length;
  const failureCount = tasks.filter((t) => t.status === "failed").length;

  return {
    summary: run.description,
    totalCost: run.totalCost,
    projectCount: tasks.length,
    successCount,
    failureCount,
    perProject,
  };
}

/**
 * Format aggregated results as a markdown string for display.
 */
export function formatAggregatedResults(result: AggregatedResult): string {
  const lines: string[] = [];

  lines.push(`Orchestration: ${result.summary}`);
  lines.push(
    `${result.successCount}/${result.projectCount} projects completed · $${result.totalCost.toFixed(4)} total`,
  );
  lines.push("");

  for (const p of result.perProject) {
    const icon =
      p.status === "completed"
        ? "✓"
        : p.status === "failed"
          ? "✗"
          : p.status === "skipped"
            ? "○"
            : "●";
    lines.push(`  ${icon} ${p.name} ($${p.cost.toFixed(4)})`);
    if (p.summary && p.summary !== "No output") {
      // Indent and truncate summary
      const summaryLines = p.summary.split("\n").slice(0, 3);
      for (const sl of summaryLines) {
        lines.push(`    ${sl.slice(0, 120)}`);
      }
    }
  }

  return lines.join("\n");
}
