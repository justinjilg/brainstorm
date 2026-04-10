/**
 * Project indexer — walks a project directory and parses all TypeScript files,
 * building the code graph.
 *
 * Skips: node_modules, dist, .git, build, .turbo, coverage, .next
 */

import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { parseFile } from "./parser.js";
import { CodeGraph } from "./graph.js";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "build",
  ".turbo",
  "coverage",
  ".next",
  ".cache",
  "out",
]);

const VALID_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export interface IndexProgress {
  filesScanned: number;
  filesIndexed: number;
  errors: number;
  elapsedMs: number;
}

/**
 * Walk a project directory and index all TypeScript files into the code graph.
 */
export function indexProject(
  projectPath: string,
  opts: {
    graph?: CodeGraph;
    onProgress?: (progress: IndexProgress) => void;
    maxFiles?: number;
  } = {},
): { graph: CodeGraph; progress: IndexProgress } {
  const graph = opts.graph ?? new CodeGraph({ projectPath });
  const start = Date.now();
  const progress: IndexProgress = {
    filesScanned: 0,
    filesIndexed: 0,
    errors: 0,
    elapsedMs: 0,
  };
  const maxFiles = opts.maxFiles ?? Infinity;

  const stack: string[] = [projectPath];
  while (stack.length > 0 && progress.filesIndexed < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".brainstorm") continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        stack.push(fullPath);
        continue;
      }
      if (!stat.isFile()) continue;

      // Skip dotfiles, test fixtures, .d.ts
      if (entry.endsWith(".d.ts")) continue;
      if (!VALID_EXTENSIONS.has(extname(entry))) continue;

      progress.filesScanned++;
      try {
        const parsed = parseFile(fullPath);
        graph.upsertFile(parsed);
        progress.filesIndexed++;
        if (opts.onProgress && progress.filesIndexed % 25 === 0) {
          progress.elapsedMs = Date.now() - start;
          opts.onProgress(progress);
        }
      } catch (err) {
        progress.errors++;
      }

      if (progress.filesIndexed >= maxFiles) break;
    }
  }

  progress.elapsedMs = Date.now() - start;
  return { graph, progress };
}
