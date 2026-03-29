/**
 * Language Detection — identifies programming languages in a codebase.
 *
 * Deterministic analysis: no LLM needed. Counts files and lines per language.
 * Used by the ingest pipeline to understand what the codebase is built with.
 *
 * Flywheel: detected languages feed into routing profiles — "TypeScript projects
 * route code-generation to Sonnet" learned over time from outcome data.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

export interface LanguageBreakdown {
  /** Primary language (most lines of code). */
  primary: string;
  /** All detected languages sorted by line count. */
  languages: Array<{
    language: string;
    files: number;
    lines: number;
    percentage: number;
  }>;
  /** Total lines of code (excluding blank lines). */
  totalLines: number;
  /** Total files analyzed. */
  totalFiles: number;
}

const EXTENSION_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".scala": "Scala",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".cpp": "C++",
  ".c": "C",
  ".h": "C",
  ".hpp": "C++",
  ".swift": "Swift",
  ".m": "Objective-C",
  ".sql": "SQL",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
  ".lua": "Lua",
  ".r": "R",
  ".R": "R",
  ".dart": "Dart",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".erl": "Erlang",
  ".zig": "Zig",
  ".v": "V",
  ".nim": "Nim",
  ".cob": "COBOL",
  ".cbl": "COBOL",
  ".cpy": "COBOL",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

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
  ".idea",
  ".vscode",
  "coverage",
]);

/**
 * Detect all programming languages in a directory.
 * Walks the file tree, counts files and lines per language.
 */
export function detectLanguages(
  projectPath: string,
  maxDepth = 10,
): LanguageBreakdown {
  const counts = new Map<string, { files: number; lines: number }>();
  let totalLines = 0;
  let totalFiles = 0;

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".") continue;
      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        const language = EXTENSION_MAP[ext];
        if (!language) continue;

        // Count non-blank lines
        let lineCount = 0;
        try {
          const content = readFileSync(fullPath, "utf-8");
          lineCount = content
            .split("\n")
            .filter((l) => l.trim().length > 0).length;
        } catch {
          continue;
        }

        const current = counts.get(language) ?? { files: 0, lines: 0 };
        current.files++;
        current.lines += lineCount;
        counts.set(language, current);

        totalLines += lineCount;
        totalFiles++;
      }
    }
  }

  walk(projectPath, 0);

  const languages = Array.from(counts.entries())
    .map(([language, { files, lines }]) => ({
      language,
      files,
      lines,
      percentage: totalLines > 0 ? Math.round((lines / totalLines) * 100) : 0,
    }))
    .sort((a, b) => b.lines - a.lines);

  return {
    primary: languages[0]?.language ?? "Unknown",
    languages,
    totalLines,
    totalFiles,
  };
}
