/**
 * Phase 1: Deep Exploration — LLM reads key files and discovers conventions.
 *
 * This is the core innovation of storm onboard. Instead of generic analysis,
 * the LLM actually reads representative source files, test files, configs,
 * and git history to discover real conventions and domain concepts.
 *
 * File selection is deterministic (no LLM needed):
 * - Entry points (up to 5, first 100 lines each)
 * - Config files (tsconfig, package.json, CI, linter)
 * - README.md
 * - One test file (to discover testing patterns)
 * - One source file per module cluster (highest complexity)
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ProjectAnalysis } from "@brainst0rm/ingest";
import type {
  OnboardContext,
  OnboardDispatcher,
  ExplorationResult,
} from "../types.js";
import { buildExplorationPrompt } from "../prompts/exploration.js";

/** Max lines to read from any single file. */
const MAX_LINES_PER_FILE = 100;
/** Max files to include in the prompt. */
const MAX_FILES = 20;
/** Max total characters for all file contents. */
const MAX_TOTAL_CHARS = 50_000;

interface PhaseResult {
  contextPatch: Partial<OnboardContext>;
  cost: number;
  summary: string;
}

/**
 * Run deep exploration: select key files, build prompt, call LLM.
 */
export async function runDeepExploration(
  context: OnboardContext,
  dispatcher: OnboardDispatcher,
): Promise<PhaseResult> {
  const { analysis } = context;
  const gitSummary = (context as any)._gitSummary ?? "";

  // Select key files to include in the prompt
  const selectedFiles = selectKeyFiles(analysis);

  // Read file contents (truncated)
  const fileContents = readSelectedFiles(analysis.projectPath, selectedFiles);

  // Build the exploration prompt
  const prompt = buildExplorationPrompt(analysis, fileContents, gitSummary);

  // Call LLM
  const response = await dispatcher.generate(prompt, 0.3);

  // Parse the response as JSON
  let exploration: ExplorationResult;
  try {
    exploration = parseExplorationResponse(response.text);
  } catch (error) {
    // If JSON parse fails, return a minimal result
    exploration = createFallbackResult(analysis);
  }

  const conceptCount = exploration.domainConcepts.length;
  const conventionCount = countConventions(exploration.conventions);
  const workflowDesc = exploration.gitWorkflow.branchStrategy;

  return {
    contextPatch: { exploration },
    cost: response.cost,
    summary: `${conventionCount} conventions, ${conceptCount} domain concepts, ${workflowDesc} workflow`,
  };
}

/**
 * Select key files to include in the exploration prompt.
 * Deterministic selection — no LLM needed.
 */
function selectKeyFiles(analysis: ProjectAnalysis): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  const add = (path: string) => {
    if (seen.has(path) || files.length >= MAX_FILES) return;
    seen.add(path);
    files.push(path);
  };

  // 1. Entry points (up to 5)
  for (const ep of analysis.dependencies.entryPoints.slice(0, 5)) {
    add(ep);
  }

  // 2. Config files
  const configFiles = [
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    "eslint.config.js",
    "eslint.config.mjs",
    ".prettierrc",
    ".prettierrc.json",
    "prettier.config.js",
    "turbo.json",
    "vercel.json",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "vite.config.ts",
    "vitest.config.ts",
    "jest.config.ts",
    "jest.config.js",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".github/workflows/ci.yml",
    ".github/workflows/ci.yaml",
    ".github/workflows/test.yml",
    ".github/workflows/deploy.yml",
  ];

  for (const cf of configFiles) {
    const fullPath = join(analysis.projectPath, cf);
    if (existsSync(fullPath)) {
      add(cf);
    }
  }

  // 3. README
  for (const readme of ["README.md", "readme.md", "Readme.md"]) {
    const fullPath = join(analysis.projectPath, readme);
    if (existsSync(fullPath)) {
      add(readme);
      break;
    }
  }

  // 4. One test file (find first .test. or .spec. file)
  const testFile = findTestFile(analysis);
  if (testFile) add(testFile);

  // 5. Highest-complexity source file per module cluster (up to 5)
  for (const cluster of analysis.dependencies.clusters.slice(0, 5)) {
    const hottest = findHottestFile(analysis, cluster.files);
    if (hottest) add(hottest);
  }

  return files;
}

/**
 * Find a representative test file from the project.
 */
function findTestFile(analysis: ProjectAnalysis): string | null {
  for (const node of analysis.dependencies.nodes) {
    if (
      node.path.includes(".test.") ||
      node.path.includes(".spec.") ||
      node.path.includes("__tests__/")
    ) {
      return node.path;
    }
  }
  return null;
}

/**
 * Find the highest-complexity file in a set of file paths.
 */
function findHottestFile(
  analysis: ProjectAnalysis,
  files: string[],
): string | null {
  let best: { path: string; score: number } | null = null;
  for (const f of files) {
    const fc = analysis.complexity.files.find((c) => c.path === f);
    if (fc && (!best || fc.score > best.score)) {
      best = { path: fc.path, score: fc.score };
    }
  }
  return best?.path ?? files[0] ?? null;
}

/**
 * Read selected files, truncating each to MAX_LINES_PER_FILE.
 * Stops adding files if total characters would exceed MAX_TOTAL_CHARS.
 */
function readSelectedFiles(
  projectPath: string,
  files: string[],
): Map<string, string> {
  const contents = new Map<string, string>();
  let totalChars = 0;

  for (const file of files) {
    const fullPath = join(projectPath, file);
    if (!existsSync(fullPath)) continue;

    try {
      const raw = readFileSync(fullPath, "utf-8");
      const lines = raw.split("\n").slice(0, MAX_LINES_PER_FILE);
      const truncated = lines.join("\n");

      if (totalChars + truncated.length > MAX_TOTAL_CHARS) break;

      contents.set(file, truncated);
      totalChars += truncated.length;
    } catch {
      // Skip unreadable files (binary, permissions, etc.)
    }
  }

  return contents;
}

/**
 * Parse the LLM response as an ExplorationResult.
 * Handles JSON wrapped in markdown code fences.
 */
function parseExplorationResponse(text: string): ExplorationResult {
  // Strip markdown code fences if present
  let json = text.trim();
  if (json.startsWith("```")) {
    json = json.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  const parsed = JSON.parse(json);

  // Validate required fields exist (minimal check)
  if (!parsed.conventions || !parsed.domainConcepts || !parsed.gitWorkflow) {
    throw new Error("Missing required fields in exploration response");
  }

  return parsed as ExplorationResult;
}

/**
 * Create a fallback ExplorationResult from static analysis
 * when the LLM response fails to parse.
 */
function createFallbackResult(analysis: ProjectAnalysis): ExplorationResult {
  return {
    conventions: {
      naming: {
        variables: "unknown",
        files: "unknown",
        exports: "unknown",
      },
      errorHandling: "unknown",
      testingPatterns:
        analysis.frameworks.testing.length > 0
          ? `Uses ${analysis.frameworks.testing.join(", ")}`
          : "No testing framework detected",
      importStyle: "unknown",
      customRules: [],
    },
    domainConcepts: [],
    gitWorkflow: {
      commitStyle: "unknown",
      branchStrategy: "unknown",
      prPatterns: "unknown",
      typicalPRSize: "unknown",
      activeContributors: 1,
    },
    cicdSetup: {
      provider: analysis.frameworks.ci?.[0] ?? "none",
      stages: [],
      deployTarget: analysis.frameworks.deployment?.[0] ?? "none",
      hasPreCommitHooks: false,
    },
    keyFiles: [],
    projectPurpose: `A ${analysis.summary.primaryLanguage} project using ${analysis.summary.frameworkList.join(", ") || "no detected frameworks"}.`,
  };
}

/**
 * Count non-empty convention fields.
 */
function countConventions(
  conventions: ExplorationResult["conventions"],
): number {
  let count = 0;
  if (conventions.naming.variables !== "unknown") count++;
  if (conventions.naming.files !== "unknown") count++;
  if (conventions.naming.components) count++;
  if (conventions.naming.exports !== "unknown") count++;
  if (conventions.errorHandling !== "unknown") count++;
  if (
    conventions.testingPatterns &&
    !conventions.testingPatterns.startsWith("No")
  )
    count++;
  if (conventions.importStyle !== "unknown") count++;
  if (conventions.stateManagement) count++;
  if (conventions.apiPatterns) count++;
  count += conventions.customRules.length;
  return count;
}
