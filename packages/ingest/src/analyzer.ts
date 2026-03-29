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

  const summary: AnalysisSummary = {
    primaryLanguage: languages.primary,
    totalFiles: languages.totalFiles,
    totalLines: languages.totalLines,
    frameworkList: [...frameworks.frameworks, ...frameworks.buildTools],
    moduleCount: dependencies.clusters.length,
    avgComplexity: complexity.summary.avgComplexity,
    hotspotCount: complexity.summary.hotspots.length,
    entryPointCount: dependencies.entryPoints.length,
  };

  return {
    projectPath,
    analyzedAt: new Date().toISOString(),
    languages,
    frameworks,
    dependencies,
    complexity,
    summary,
  };
}
