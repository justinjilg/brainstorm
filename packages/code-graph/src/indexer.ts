/**
 * Project indexer — walks a project directory and parses all supported files,
 * building the code graph.
 *
 * Multi-language: indexes any file whose extension has a registered adapter.
 * TypeScript is always available. Python, Go, Rust, Java require optional deps.
 *
 * Skips: node_modules, dist, .git, build, .turbo, coverage, .next
 */

import { readdirSync, statSync } from "node:fs";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("indexer");
import { join, extname } from "node:path";
import { parseFile } from "./parser.js";
import { CodeGraph } from "./graph.js";
import {
  supportedExtensions,
  initializeAdapters,
  registerAdapter,
} from "./languages/registry.js";
import { createTypeScriptAdapter } from "./languages/typescript.js";

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

export interface IndexProgress {
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  errors: number;
  elapsedMs: number;
  languages: string[];
}

/**
 * Walk a project directory and index all supported files into the code graph.
 */
export async function indexProject(
  projectPath: string,
  opts: {
    graph?: CodeGraph;
    onProgress?: (progress: IndexProgress) => void;
    maxFiles?: number;
  } = {},
): Promise<{ graph: CodeGraph; progress: IndexProgress }> {
  // Initialize language adapters (loads optional grammars)
  const loadedLanguages = await initializeAdapters();
  const validExtensions = supportedExtensions();

  const graph = opts.graph ?? new CodeGraph({ projectPath });
  const start = Date.now();
  const progress: IndexProgress = {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    errors: 0,
    elapsedMs: 0,
    languages: loadedLanguages,
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

      // Skip dotfiles, .d.ts
      if (entry.endsWith(".d.ts")) continue;
      const ext = extname(entry);
      if (!validExtensions.has(ext)) {
        progress.filesSkipped++;
        continue;
      }

      progress.filesScanned++;
      try {
        const parsed = parseFile(fullPath);
        if (parsed) {
          graph.upsertFile(parsed);
          progress.filesIndexed++;
        } else {
          progress.filesSkipped++;
        }
        if (opts.onProgress && progress.filesIndexed % 25 === 0) {
          progress.elapsedMs = Date.now() - start;
          opts.onProgress(progress);
        }
      } catch (err) {
        progress.errors++;
        // Abort if error rate exceeds 10% (after at least 20 files attempted)
        if (
          progress.filesScanned >= 20 &&
          progress.errors / progress.filesScanned > 0.1
        ) {
          log.warn(
            { errors: progress.errors, scanned: progress.filesScanned },
            "Aborting indexing — error rate exceeds 10%",
          );
          break;
        }
      }

      if (progress.filesIndexed >= maxFiles) break;
    }
  }

  progress.elapsedMs = Date.now() - start;
  return { graph, progress };
}

/**
 * Synchronous indexer for backward compatibility.
 * Uses only TypeScript (always available, no async init needed).
 */
export function indexProjectSync(
  projectPath: string,
  opts: {
    graph?: CodeGraph;
    onProgress?: (progress: IndexProgress) => void;
    maxFiles?: number;
  } = {},
): { graph: CodeGraph; progress: IndexProgress } {
  // Register TypeScript adapter (always available — bundled dep)
  registerAdapter(createTypeScriptAdapter());

  const validExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
  const graph = opts.graph ?? new CodeGraph({ projectPath });
  const start = Date.now();
  const progress: IndexProgress = {
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    errors: 0,
    elapsedMs: 0,
    languages: ["typescript"],
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

      if (entry.endsWith(".d.ts")) continue;
      if (!validExtensions.has(extname(entry))) continue;

      progress.filesScanned++;
      try {
        const parsed = parseFile(fullPath);
        if (parsed) {
          graph.upsertFile(parsed);
          progress.filesIndexed++;
        }
        if (opts.onProgress && progress.filesIndexed % 25 === 0) {
          progress.elapsedMs = Date.now() - start;
          opts.onProgress(progress);
        }
      } catch {
        progress.errors++;
      }

      if (progress.filesIndexed >= maxFiles) break;
    }
  }

  progress.elapsedMs = Date.now() - start;
  return { graph, progress };
}
