/**
 * Style Learner — detect coding conventions from the codebase.
 *
 * Analyzes existing code for patterns: indent style, quote style,
 * naming conventions, import ordering. Injects as "Project Style Guide"
 * in the system prompt. Pure regex analysis — no LLM needed.
 *
 * Inspired by Augment Code's persistent learning from codebase style.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRepoMap } from "../agent/repo-map.js";

export interface StyleProfile {
  indentStyle: "tabs" | "spaces-2" | "spaces-4" | "mixed";
  quoteStyle: "single" | "double" | "mixed";
  semicolons: "always" | "never" | "mixed";
  namingConvention: "camelCase" | "snake_case" | "mixed";
  trailingCommas: "yes" | "no" | "mixed";
  importStyle: "named" | "default" | "mixed";
}

// Cache: style rarely changes within a session
let _styleCache: { path: string; profile: StyleProfile; ts: number } | null =
  null;
const STYLE_TTL_MS = 120_000;

/**
 * Analyze the codebase and detect coding style conventions.
 */
export function learnStyle(projectPath: string): StyleProfile {
  if (
    _styleCache &&
    _styleCache.path === projectPath &&
    Date.now() - _styleCache.ts < STYLE_TTL_MS
  ) {
    return _styleCache.profile;
  }

  const map = buildRepoMap(projectPath, 20);
  const counts = {
    tabs: 0,
    spaces2: 0,
    spaces4: 0,
    singleQuote: 0,
    doubleQuote: 0,
    withSemicolon: 0,
    withoutSemicolon: 0,
    camelCase: 0,
    snakeCase: 0,
    trailingComma: 0,
    noTrailingComma: 0,
    namedImport: 0,
    defaultImport: 0,
  };

  for (const entry of map.entries.slice(0, 30)) {
    try {
      const content = readFileSync(join(projectPath, entry.file), "utf-8");
      analyzeFile(content, counts);
    } catch {
      // skip
    }
  }

  const profile: StyleProfile = {
    indentStyle: majority(counts.tabs, counts.spaces2 + counts.spaces4)
      ? "tabs"
      : counts.spaces2 > counts.spaces4
        ? "spaces-2"
        : "spaces-4",
    quoteStyle: majority(counts.singleQuote, counts.doubleQuote)
      ? "single"
      : majority(counts.doubleQuote, counts.singleQuote)
        ? "double"
        : "mixed",
    semicolons: majority(counts.withSemicolon, counts.withoutSemicolon)
      ? "always"
      : majority(counts.withoutSemicolon, counts.withSemicolon)
        ? "never"
        : "mixed",
    namingConvention: majority(counts.camelCase, counts.snakeCase)
      ? "camelCase"
      : majority(counts.snakeCase, counts.camelCase)
        ? "snake_case"
        : "mixed",
    trailingCommas: majority(counts.trailingComma, counts.noTrailingComma)
      ? "yes"
      : majority(counts.noTrailingComma, counts.trailingComma)
        ? "no"
        : "mixed",
    importStyle: majority(counts.namedImport, counts.defaultImport)
      ? "named"
      : majority(counts.defaultImport, counts.namedImport)
        ? "default"
        : "mixed",
  };

  _styleCache = { path: projectPath, profile, ts: Date.now() };
  return profile;
}

function majority(a: number, b: number): boolean {
  return a > b * 2;
}

function analyzeFile(content: string, counts: Record<string, number>): void {
  const lines = content.split("\n").slice(0, 100);

  for (const line of lines) {
    // Indent style
    if (line.startsWith("\t")) counts.tabs++;
    else if (line.startsWith("  ") && !line.startsWith("    "))
      counts.spaces2++;
    else if (line.startsWith("    ")) counts.spaces4++;

    // Quote style
    const singleMatches = line.match(/'/g);
    const doubleMatches = line.match(/"/g);
    if (singleMatches) counts.singleQuote += singleMatches.length;
    if (doubleMatches) counts.doubleQuote += doubleMatches.length;

    // Semicolons (non-empty statement lines)
    const trimmed = line.trim();
    if (
      trimmed.length > 3 &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("*") &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("}")
    ) {
      if (trimmed.endsWith(";")) counts.withSemicolon++;
      else if (
        !trimmed.endsWith("{") &&
        !trimmed.endsWith("(") &&
        !trimmed.endsWith(",")
      )
        counts.withoutSemicolon++;
    }

    // Trailing commas
    if (trimmed.endsWith(",")) counts.trailingComma++;
  }

  // Naming conventions (from function/variable names)
  const camelMatches = content.match(
    /(?:function|const|let|var)\s+([a-z][a-zA-Z0-9]+)/g,
  );
  const snakeMatches = content.match(
    /(?:function|const|let|var)\s+([a-z][a-z0-9_]+)/g,
  );
  if (camelMatches) counts.camelCase += camelMatches.length;
  if (snakeMatches) counts.snakeCase += snakeMatches.length;

  // Import style
  const namedImports = content.match(/import\s+\{/g);
  const defaultImports = content.match(/import\s+\w+\s+from/g);
  if (namedImports) counts.namedImport += namedImports.length;
  if (defaultImports) counts.defaultImport += defaultImports.length;
}

/**
 * Format style profile as a context section for the system prompt.
 */
export function formatStyleContext(projectPath: string): string | null {
  const style = learnStyle(projectPath);

  const lines: string[] = [];
  if (style.indentStyle !== "mixed")
    lines.push(`- Indentation: ${style.indentStyle}`);
  if (style.quoteStyle !== "mixed") lines.push(`- Quotes: ${style.quoteStyle}`);
  if (style.semicolons !== "mixed")
    lines.push(`- Semicolons: ${style.semicolons}`);
  if (style.namingConvention !== "mixed")
    lines.push(`- Naming: ${style.namingConvention}`);
  if (style.trailingCommas !== "mixed")
    lines.push(`- Trailing commas: ${style.trailingCommas}`);
  if (style.importStyle !== "mixed")
    lines.push(`- Imports: ${style.importStyle}`);

  if (lines.length === 0) return null;
  return lines.join("\n");
}
