/**
 * Project Analyzer — top-level entry point for codebase analysis.
 *
 * Combines language detection, framework detection, dependency graph,
 * and complexity analysis into a single ProjectAnalysis object.
 *
 * This is what runs when someone says "understand this codebase."
 * No LLM needed — pure deterministic analysis.
 *
 * Flywheel: the ProjectAnalysis seeds everything downstream:
 * - BRAINSTORM.md generation (project context for agents)
 * - .agent.md generation (domain experts per module cluster)
 * - Routing profiles (model selection tuned to the project)
 * - All of which produce better outcomes → better routing over time
 */

import { detectLanguages, type LanguageBreakdown } from "./languages.js";
import { detectFrameworks, type FrameworkDetection } from "./frameworks.js";
import { buildDependencyGraph, type DependencyGraph } from "./dependencies.js";
import { computeComplexity, type ComplexityReport } from "./complexity.js";
import { mapEndpoints, type EndpointMap } from "./endpoints.js";

export interface DeepGraphAnalysis {
  /** Total symbol counts from AST parsing. */
  stats: {
    files: number;
    functions: number;
    classes: number;
    methods: number;
    callEdges: number;
    nodes: number;
    graphEdges: number;
    communities: number;
  };
  /** Languages actually parsed by tree-sitter (not just line-counted). */
  parsedLanguages: string[];
  /** Community clusters detected via Louvain algorithm. */
  communities: Array<{
    id: string;
    name: string | null;
    nodeCount: number;
    complexityScore: number | null;
  }>;
  /** Top exported symbols (functions/classes with exported=true). */
  exports: Array<{
    name: string;
    kind: "function" | "class" | "method";
    file: string;
    line: number;
  }>;
  /** Most-called symbols (hotspots in the call graph). */
  callHotspots: Array<{
    name: string;
    callerCount: number;
    file: string;
  }>;
  /** Cross-file resolution stats. */
  crossFile: {
    resolved: number;
    unresolved: number;
  };
  /** Pipeline execution time in ms. */
  pipelineMs: number;
}

export interface ProjectAnalysis {
  /** Absolute path to the project root. */
  projectPath: string;
  /** When the analysis was performed. */
  analyzedAt: string;
  /** Language breakdown (lines, files, percentages). */
  languages: LanguageBreakdown;
  /** Detected frameworks, build tools, databases, deployment targets. */
  frameworks: FrameworkDetection;
  /** File dependency graph with module clusters. */
  dependencies: DependencyGraph;
  /** Per-file and aggregate complexity metrics. */
  complexity: ComplexityReport;
  /** API endpoints discovered from route definitions. */
  endpoints: EndpointMap;
  /** Deep AST-based graph analysis (tree-sitter). Only present when --deep or full ingest. */
  graph?: DeepGraphAnalysis;
  /** Quick summary for display. */
  summary: AnalysisSummary;
}

export interface AnalysisSummary {
  primaryLanguage: string;
  totalFiles: number;
  totalLines: number;
  frameworkList: string[];
  moduleCount: number;
  avgComplexity: number;
  hotspotCount: number;
  entryPointCount: number;
  apiRouteCount: number;
}

/**
 * Analyze a project directory. Pure deterministic analysis — no LLM, no network.
 *
 * This is Phase 1 of the ingest pipeline. Returns structured data that
 * Phase 2 (docgen) and Phase 3 (infra setup) consume.
 */
export function analyzeProject(projectPath: string): ProjectAnalysis {
  const languages = detectLanguages(projectPath);
  const frameworks = detectFrameworks(projectPath);
  const dependencies = buildDependencyGraph(projectPath);
  const complexity = computeComplexity(projectPath);
  const endpoints = mapEndpoints(projectPath);

  const summary: AnalysisSummary = {
    primaryLanguage: languages.primary,
    totalFiles: languages.totalFiles,
    totalLines: languages.totalLines,
    frameworkList: [...frameworks.frameworks, ...frameworks.buildTools],
    moduleCount: dependencies.clusters.length,
    avgComplexity: complexity.summary.avgComplexity,
    hotspotCount: complexity.summary.hotspots.length,
    entryPointCount: dependencies.entryPoints.length,
    apiRouteCount: endpoints.totalRoutes,
  };

  return {
    projectPath,
    analyzedAt: new Date().toISOString(),
    languages,
    frameworks,
    dependencies,
    complexity,
    endpoints,
    summary,
  };
}

/**
 * Run deep AST-based analysis using the code-graph pipeline (tree-sitter).
 *
 * This goes beyond regex line-counting: it parses actual source files into
 * ASTs, extracts functions/classes/methods/call-sites/imports, builds a
 * SQLite knowledge graph, resolves cross-file edges, detects communities
 * via Louvain, and returns structured graph data.
 *
 * Supports: TypeScript (bundled), Rust, Go, Python, Java (optional grammars).
 */
export async function runDeepAnalysis(
  projectPath: string,
): Promise<DeepGraphAnalysis> {
  const startTime = Date.now();

  const {
    CodeGraph,
    initializeAdapters,
    createDefaultPipeline,
    executePipeline,
  } = await import("@brainst0rm/code-graph");

  // Initialize all available tree-sitter adapters (TS bundled, rest optional)
  await initializeAdapters();

  // Create a project-scoped graph DB
  const graph = new CodeGraph({ projectPath });

  // Run the full pipeline: scan → parse → graph-build → cross-file → communities → summary
  const pipeline = createDefaultPipeline();
  const ctx = { projectPath, graph, results: new Map<string, unknown>() };
  await executePipeline(pipeline, ctx);

  const stats = graph.extendedStats();
  const communities = graph.getCommunities();

  // Extract exported symbols
  const db = graph.getDb();
  const exports = db
    .prepare(
      `SELECT name, 'function' AS kind, file, start_line AS line
       FROM functions WHERE exported = 1
       UNION ALL
       SELECT name, 'class' AS kind, file, start_line AS line
       FROM classes WHERE exported = 1
       ORDER BY file, line
       LIMIT 200`,
    )
    .all() as Array<{
    name: string;
    kind: "function" | "class";
    file: string;
    line: number;
  }>;

  // Find call hotspots (most-called symbols)
  const callHotspots = db
    .prepare(
      `SELECT callee AS name, COUNT(*) AS callerCount,
              (SELECT file FROM functions WHERE name = ce.callee LIMIT 1) AS file
       FROM call_edges ce
       GROUP BY callee
       HAVING callerCount > 1
       ORDER BY callerCount DESC
       LIMIT 30`,
    )
    .all() as Array<{ name: string; callerCount: number; file: string }>;

  // Cross-file resolution stats from pipeline context
  const crossFileResult = ctx.results.get("cross-file") as
    | { resolvedCalls?: number; unresolvedCalls?: number }
    | undefined;

  // Pipeline summary for parsed languages
  const summaryResult = ctx.results.get("summary") as
    | { languages?: string[] }
    | undefined;

  return {
    stats,
    parsedLanguages: summaryResult?.languages ?? [],
    communities,
    exports,
    callHotspots: callHotspots.filter((h) => h.file !== null),
    crossFile: {
      resolved: crossFileResult?.resolvedCalls ?? 0,
      unresolved: crossFileResult?.unresolvedCalls ?? 0,
    },
    pipelineMs: Date.now() - startTime,
  };
}
