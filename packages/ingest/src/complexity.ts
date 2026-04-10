/**
 * Complexity Analysis — measures code complexity across the codebase.
 *
 * Computes per-file and aggregate complexity metrics.
 * Used by ingest to identify hotspots, estimate effort, and prioritize review.
 *
 * Flywheel: complexity scores → routing profiles. Complex modules route to
 * Opus/GPT-5.4, simple modules route to Haiku/Flash. Learned over time.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

export interface ComplexityReport {
  /** Per-file complexity scores. */
  files: FileComplexity[];
  /** Aggregate metrics. */
  summary: {
    totalFiles: number;
    totalLines: number;
    avgComplexity: number;
    hotspots: string[];
    avgFileSize: number;
    largestFile: { path: string; lines: number } | null;
  };
}

export interface FileComplexity {
  path: string;
  lines: number;
  /** Estimated cyclomatic complexity (branch count). */
  branchCount: number;
  /** Nesting depth (max indentation level). */
  maxNesting: number;
  /** Function/method count. */
  functionCount: number;
  /** Composite complexity score (0-100). */
  score: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".gradle",
  "vendor",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".c",
  ".h",
]);

// Patterns that increase cyclomatic complexity (branch points)
const BRANCH_PATTERNS = [
  /\bif\s*\(/g,
  /\belse\s+if\b/g,
  /\belse\b/g,
  /\bswitch\s*\(/g,
  /\bcase\s+/g,
  /\bfor\s*\(/g,
  /\bwhile\s*\(/g,
  /\bcatch\s*\(/g,
  /\?\?/g, // nullish coalescing
  /\?\./g, // optional chaining (each is a hidden branch)
  /\?\s*[^:]/g, // ternary
  /&&/g,
  /\|\|/g,
];

const FUNCTION_PATTERNS = [
  /\bfunction\s+\w/g,
  /\bconst\s+\w+\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/g,
  /\b(?:async\s+)?(?:def|fn)\s+\w/g,
  /\bfunc\s+\w/g,
  /\bpub\s+fn\s+\w/g,
];

/**
 * Compute complexity metrics for all code files in a project.
 */
export function computeComplexity(projectPath: string): ComplexityReport {
  const files: FileComplexity[] = [];
  let totalLines = 0;

  function walk(dir: string, depth: number): void {
    if (depth > 10) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (CODE_EXTENSIONS.has(extname(entry).toLowerCase())) {
        const fc = analyzeFile(full, projectPath);
        if (fc) {
          files.push(fc);
          totalLines += fc.lines;
        }
      }
    }
  }

  walk(projectPath, 0);

  // Sort by score descending (most complex first)
  files.sort((a, b) => b.score - a.score);

  const avgComplexity =
    files.length > 0
      ? Math.round(files.reduce((sum, f) => sum + f.score, 0) / files.length)
      : 0;

  const hotspots = files
    .filter((f) => f.score >= 70)
    .slice(0, 10)
    .map((f) => f.path);

  const largest =
    files.length > 0
      ? files.reduce((max, f) => (f.lines > max.lines ? f : max))
      : null;

  return {
    files,
    summary: {
      totalFiles: files.length,
      totalLines,
      avgComplexity,
      hotspots,
      avgFileSize: files.length > 0 ? Math.round(totalLines / files.length) : 0,
      largestFile: largest
        ? { path: largest.path, lines: largest.lines }
        : null,
    },
  };
}

export function calculateComplexity(
  content: string,
): Omit<FileComplexity, "path"> | null {
  const lines = content.split("\n");
  const nonBlank = lines.filter((l) => l.trim().length > 0).length;
  if (nonBlank === 0) return null;

  // Count branch points
  let branchCount = 0;
  for (const pattern of BRANCH_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    branchCount += matches?.length ?? 0;
  }

  // Count functions
  let functionCount = 0;
  for (const pattern of FUNCTION_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    functionCount += matches?.length ?? 0;
  }

  // Max nesting depth (by indentation)
  let maxNesting = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    const level = Math.floor(indent / 2); // 2-space indent
    if (level > maxNesting) maxNesting = level;
  }

  // Composite score (0-100)
  const lineScore = Math.min(30, (nonBlank / 500) * 30); // 500+ lines = max
  const branchScore = Math.min(30, (branchCount / 50) * 30); // 50+ branches = max
  const nestingScore = Math.min(20, (maxNesting / 8) * 20); // 8+ levels = max
  const functionScore = Math.min(20, (functionCount / 20) * 20); // 20+ functions = max

  const score = Math.round(
    lineScore + branchScore + nestingScore + functionScore,
  );

  return {
    lines: nonBlank,
    branchCount,
    maxNesting,
    functionCount,
    score: Math.min(100, score),
  };
}

function analyzeFile(
  filePath: string,
  projectPath: string,
): FileComplexity | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const metrics = calculateComplexity(content);
  if (!metrics) return null;

  return {
    path: relative(projectPath, filePath),
    ...metrics,
  };
}
