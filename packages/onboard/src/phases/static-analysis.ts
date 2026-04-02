/**
 * Phase 0: Static Analysis — deterministic codebase analysis.
 *
 * Wraps analyzeProject() from @brainst0rm/ingest. Zero cost.
 * Also collects git history for Phase 1 to consume.
 *
 * This is the foundation — every subsequent phase builds on
 * the ProjectAnalysis it returns.
 */

import { analyzeProject, type ProjectAnalysis } from "@brainst0rm/ingest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface StaticAnalysisResult {
  analysis: ProjectAnalysis;
  gitSummary: string;
}

/**
 * Run static analysis on a project directory.
 *
 * Returns the structured ProjectAnalysis plus a git log summary
 * string for the exploration phase to include in its prompt.
 */
export function runStaticAnalysis(projectPath: string): StaticAnalysisResult {
  const analysis = analyzeProject(projectPath);
  const gitSummary = collectGitSummary(projectPath);

  return { analysis, gitSummary };
}

/**
 * Collect a git log summary for context.
 * Returns a formatted string of recent commits, or empty if not a git repo.
 */
function collectGitSummary(projectPath: string): string {
  const gitDir = `${projectPath}/.git`;
  if (!existsSync(gitDir)) return "";

  try {
    const log = execFileSync(
      "git",
      ["log", "--oneline", "--stat", "--no-color", "-30"],
      {
        cwd: projectPath,
        encoding: "utf-8",
        timeout: 10_000,
      },
    );
    return log.trim();
  } catch {
    return "";
  }
}
