/**
 * Phase 0.5: Code Graph Build — tree-sitter knowledge graph for the project.
 *
 * Walks every TypeScript/TSX file in the project and builds a SQLite call
 * graph at ~/.brainstorm/projects/<hash>/code-graph.db. The agent then has
 * structural query tools (code_callers, code_callees, code_definition,
 * code_impact, code_stats) wired against this graph at startup.
 *
 * Zero cost — purely deterministic AST analysis. Runs after static analysis
 * (which gives us the file inventory) and before any LLM phases.
 *
 * Per the linked-crunching-hamming plan, this is the foundation for
 * Transformation 1: replace 60% of agent grep time with <1ms structural
 * queries against a knowledge graph.
 */

import { indexProject, type IndexProgress } from "@brainst0rm/code-graph";

export interface CodeGraphBuildResult {
  filesScanned: number;
  filesIndexed: number;
  errors: number;
  elapsedMs: number;
  stats: {
    files: number;
    functions: number;
    classes: number;
    methods: number;
    callEdges: number;
  };
}

/**
 * Index the project into the code graph. Returns a summary suitable for
 * the onboard pipeline's phase-completed event.
 */
export function runCodeGraphBuild(projectPath: string): CodeGraphBuildResult {
  const { graph, progress } = indexProject(projectPath);
  const stats = graph.stats();
  graph.close();
  return {
    filesScanned: progress.filesScanned,
    filesIndexed: progress.filesIndexed,
    errors: progress.errors,
    elapsedMs: progress.elapsedMs,
    stats,
  };
}
