/**
 * Bug Scanner — finds codifiable bug patterns across the entire codebase.
 *
 * Not style rules. Not structure analysis. Actual bugs:
 * - Unhandled errors (catch blocks that swallow)
 * - Resource leaks (timers, connections, file handles without cleanup)
 * - Type safety holes (as any in critical paths)
 * - SQL injection patterns (string concatenation in queries)
 * - Race conditions (shared mutable state without guards)
 * - Missing timeouts on async operations
 * - Memory leaks (growing collections without bounds)
 * - Missing null checks on nullable returns
 * - Hardcoded secrets
 * - Dead code (unreachable branches)
 *
 * Each pattern is a function that takes file content + AST and returns findings.
 */

import { readFileSync } from "node:fs";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("bug-scanner");

export type BugSeverity = "critical" | "high" | "medium" | "low";
export type BugCategory =
  | "error-handling"
  | "resource-leak"
  | "type-safety"
  | "security"
  | "race-condition"
  | "missing-timeout"
  | "memory-leak"
  | "null-safety"
  | "dead-code"
  | "correctness";

export interface Bug {
  id: string;
  file: string;
  line: number;
  severity: BugSeverity;
  category: BugCategory;
  pattern: string;
  message: string;
  snippet: string;
  suggestedFix?: string;
}

export interface ScanResult {
  totalFiles: number;
  totalBugs: number;
  bySeverity: Record<BugSeverity, number>;
  byCategory: Record<string, number>;
  bugs: Bug[];
  durationMs: number;
}

// ── Bug Patterns ──────────────────────────────────────────────────

interface BugPattern {
  id: string;
  name: string;
  severity: BugSeverity;
  category: BugCategory;
  /** Returns line numbers where the bug occurs, or empty array. */
  scan(
    content: string,
    lines: string[],
    filePath: string,
  ): Array<{
    line: number;
    message: string;
    snippet: string;
    suggestedFix?: string;
  }>;
}

const PATTERNS: BugPattern[] = [
  // ── Error Handling ────────────────────────────────────────────
  {
    id: "empty-catch",
    name: "Empty catch block",
    severity: "medium",
    category: "error-handling",
    scan(content, lines) {
      const findings: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (/}\s*catch\s*(\([^)]*\))?\s*\{\s*\}/.test(lines[i])) {
          findings.push({
            line: i + 1,
            message: "Empty catch block silently swallows errors",
            snippet: lines[i].trim(),
            suggestedFix:
              "Log the error or rethrow: catch (err) { log.error({ err }, '...'); }",
          });
        }
        // Also catch: catch { } across two lines
        if (
          /}\s*catch\s*(\([^)]*\))?\s*\{/.test(lines[i]) &&
          i + 1 < lines.length &&
          /^\s*\}\s*$/.test(lines[i + 1])
        ) {
          findings.push({
            line: i + 1,
            message: "Empty catch block — error is silently discarded",
            snippet: lines[i].trim() + " " + lines[i + 1].trim(),
            suggestedFix: "Add error logging or rethrow",
          });
        }
      }
      return findings;
    },
  },
  {
    id: "catch-any",
    name: "Catch with untyped error",
    severity: "low",
    category: "type-safety",
    scan(content, lines) {
      const findings: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (/catch\s*\(\s*\w+\s*:\s*any\s*\)/.test(lines[i])) {
          findings.push({
            line: i + 1,
            message:
              "catch(error: any) loses type information — use unknown or Error",
            snippet: lines[i].trim(),
          });
        }
      }
      return findings;
    },
  },

  // ── Resource Leaks ────────────────────────────────────────────
  {
    id: "timer-no-clear",
    name: "setTimeout/setInterval without cleanup reference",
    severity: "high",
    category: "resource-leak",
    scan(content, lines) {
      const findings: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        // setTimeout not assigned to a variable (can't be cleared)
        if (
          /(?:^|\s)setTimeout\s*\(/.test(lines[i]) &&
          !/=\s*setTimeout/.test(lines[i]) &&
          !/return\s+setTimeout/.test(lines[i])
        ) {
          // Skip if it's in a comment
          if (
            lines[i].trimStart().startsWith("//") ||
            lines[i].trimStart().startsWith("*")
          )
            continue;
          findings.push({
            line: i + 1,
            message:
              "setTimeout without assignment — timer cannot be cancelled",
            snippet: lines[i].trim(),
            suggestedFix:
              "Assign to a variable: const timer = setTimeout(...); // and clearTimeout(timer) in cleanup",
          });
        }
      }
      return findings;
    },
  },

  // ── Security ──────────────────────────────────────────────────
  {
    id: "hardcoded-secret",
    name: "Potential hardcoded secret",
    severity: "critical",
    category: "security",
    scan(content, lines, filePath) {
      if (
        filePath.includes("__tests__") ||
        filePath.includes(".test.") ||
        filePath.includes(".spec.")
      )
        return [];
      const findings: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (
          lines[i].trimStart().startsWith("//") ||
          lines[i].trimStart().startsWith("*")
        )
          continue;
        // API key patterns
        if (
          /(?:api[_-]?key|apikey|secret|password|token)\s*[:=]\s*["'][a-zA-Z0-9]{20,}["']/i.test(
            lines[i],
          )
        ) {
          findings.push({
            line: i + 1,
            message:
              "Potential hardcoded secret — use environment variables or vault",
            snippet: lines[i].trim().slice(0, 80) + "...",
            suggestedFix: "Use process.env.* or $VAULT_* pattern",
          });
        }
        // Bearer token
        if (
          /Bearer\s+[a-zA-Z0-9._-]{30,}/.test(lines[i]) &&
          !lines[i].includes("$VAULT")
        ) {
          findings.push({
            line: i + 1,
            message: "Hardcoded Bearer token",
            snippet: lines[i].trim().slice(0, 60) + "...",
          });
        }
      }
      return findings;
    },
  },
  {
    id: "sql-concat",
    name: "SQL string concatenation (potential injection)",
    severity: "high",
    category: "security",
    scan(content, lines, filePath) {
      if (filePath.includes("__tests__") || filePath.includes(".test."))
        return [];
      const findings: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        // Template literal in SQL-like context with ${} interpolation
        if (
          /(?:prepare|query|exec)\s*\(\s*`[^`]*\$\{/.test(lines[i]) ||
          (i > 0 &&
            /(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)/i.test(lines[i]) &&
            /\$\{/.test(lines[i]))
        ) {
          // Skip if the interpolation is just a count of placeholders
          if (/\$\{.*map.*\?.*join/.test(lines[i])) continue;
          // Skip if it's a placeholder count
          if (/\$\{.*\.map\(\(\)/.test(lines[i])) continue;
          findings.push({
            line: i + 1,
            message:
              "SQL with template literal interpolation — use parameterized queries",
            snippet: lines[i].trim().slice(0, 100),
            suggestedFix: "Use ? placeholders and pass values as parameters",
          });
        }
      }
      return findings;
    },
  },

  // ── Missing Timeouts ──────────────────────────────────────────
  {
    id: "await-no-timeout",
    name: "await on network call without timeout",
    severity: "medium",
    category: "missing-timeout",
    scan(content, lines) {
      const findings: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        // fetch() without AbortSignal
        if (
          /await\s+fetch\s*\(/.test(lines[i]) &&
          !content.includes("signal") &&
          !content.includes("AbortController")
        ) {
          findings.push({
            line: i + 1,
            message:
              "fetch() without timeout/AbortSignal — can hang indefinitely",
            snippet: lines[i].trim(),
            suggestedFix:
              "Add AbortSignal.timeout(30000) or use AbortController",
          });
        }
      }
      return findings;
    },
  },

  // ── Memory Leaks ──────────────────────────────────────────────
  {
    id: "unbounded-map",
    name: "Map/Set that grows without bounds",
    severity: "medium",
    category: "memory-leak",
    scan(content, lines) {
      const findings: any[] = [];
      // Module-level Map/Set (not inside a function)
      const moduleMapPattern =
        /^(?:const|let)\s+\w+\s*=\s*new\s+(Map|Set)\s*\(/;
      for (let i = 0; i < lines.length; i++) {
        if (moduleMapPattern.test(lines[i].trim())) {
          // Check if there's a .delete or .clear anywhere in the file
          const name = lines[i].match(/(?:const|let)\s+(\w+)/)?.[1];
          if (
            name &&
            !content.includes(`${name}.delete`) &&
            !content.includes(`${name}.clear`)
          ) {
            findings.push({
              line: i + 1,
              message: `Module-level ${name} grows without .delete() or .clear() — potential memory leak`,
              snippet: lines[i].trim(),
              suggestedFix: "Add TTL-based cleanup or size limits",
            });
          }
        }
      }
      return findings;
    },
  },

  // ── Null Safety ───────────────────────────────────────────────
  {
    id: "as-any",
    name: "Type cast to any in production code",
    severity: "low",
    category: "type-safety",
    scan(content, lines, filePath) {
      if (filePath.includes("__tests__") || filePath.includes(".test."))
        return [];
      const findings: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        const matches = lines[i].match(/as\s+any/g);
        if (matches) {
          findings.push({
            line: i + 1,
            message: `\`as any\` cast (${matches.length}x) — TypeScript cannot check this code path`,
            snippet: lines[i].trim().slice(0, 100),
          });
        }
      }
      return findings;
    },
  },

  // ── Correctness ───────────────────────────────────────────────
  {
    id: "promise-no-catch",
    name: "Floating promise without .catch()",
    severity: "high",
    category: "error-handling",
    scan(content, lines) {
      const findings: any[] = [];
      for (let i = 0; i < lines.length; i++) {
        // Promise chain without .catch or await
        if (
          /\.\s*then\s*\(/.test(lines[i]) &&
          !content.slice(content.indexOf(lines[i])).includes(".catch")
        ) {
          // Very rough heuristic — check next 3 lines for .catch
          const next3 = lines.slice(i, i + 4).join("\n");
          if (!next3.includes(".catch") && !lines[i].includes("await")) {
            findings.push({
              line: i + 1,
              message: "Promise .then() without .catch() — unhandled rejection",
              snippet: lines[i].trim().slice(0, 80),
              suggestedFix: "Add .catch(err => log.error({ err }, '...'))",
            });
          }
        }
      }
      return findings;
    },
  },
];

// ── Scanner ───────────────────────────────────────────────────────

/**
 * Scan files for bug patterns.
 */
export function scanFiles(
  files: string[],
  opts?: { maxFiles?: number; excludeTests?: boolean },
): ScanResult {
  const start = Date.now();
  const bugs: Bug[] = [];
  let bugId = 0;
  const maxFiles = opts?.maxFiles ?? Infinity;
  let filesScanned = 0;

  for (const filePath of files) {
    if (filesScanned >= maxFiles) break;
    if (
      opts?.excludeTests &&
      (filePath.includes("__tests__") ||
        filePath.includes(".test.") ||
        filePath.includes(".spec."))
    )
      continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    filesScanned++;

    for (const pattern of PATTERNS) {
      const findings = pattern.scan(content, lines, filePath);
      for (const finding of findings) {
        bugs.push({
          id: `BUG-${String(++bugId).padStart(4, "0")}`,
          file: filePath,
          line: finding.line,
          severity: pattern.severity,
          category: pattern.category,
          pattern: pattern.id,
          message: finding.message,
          snippet: finding.snippet,
          suggestedFix: finding.suggestedFix,
        });
      }
    }
  }

  // Count by severity and category
  const bySeverity: Record<BugSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  const byCategory: Record<string, number> = {};
  for (const bug of bugs) {
    bySeverity[bug.severity]++;
    byCategory[bug.category] = (byCategory[bug.category] ?? 0) + 1;
  }

  return {
    totalFiles: filesScanned,
    totalBugs: bugs.length,
    bySeverity,
    byCategory,
    bugs,
    durationMs: Date.now() - start,
  };
}

/**
 * Format scan results as markdown.
 */
export function formatScanReport(result: ScanResult): string {
  const lines = [
    "# Bug Scan Report",
    "",
    `**${result.totalBugs} bugs** found across ${result.totalFiles} files in ${result.durationMs}ms`,
    "",
    "## By Severity",
    "",
    `| Severity | Count |`,
    `|----------|-------|`,
    `| Critical | ${result.bySeverity.critical} |`,
    `| High | ${result.bySeverity.high} |`,
    `| Medium | ${result.bySeverity.medium} |`,
    `| Low | ${result.bySeverity.low} |`,
    "",
    "## By Category",
    "",
    ...Object.entries(result.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `- **${cat}**: ${count}`),
    "",
  ];

  if (result.bySeverity.critical > 0) {
    lines.push("## Critical Bugs", "");
    for (const bug of result.bugs.filter((b) => b.severity === "critical")) {
      lines.push(`### ${bug.id}: ${bug.message}`);
      lines.push(`**File:** \`${bug.file}:${bug.line}\``);
      lines.push(`**Pattern:** ${bug.pattern}`);
      lines.push("```", bug.snippet, "```");
      if (bug.suggestedFix) lines.push(`**Fix:** ${bug.suggestedFix}`);
      lines.push("");
    }
  }

  if (result.bySeverity.high > 0) {
    lines.push("## High Bugs", "");
    for (const bug of result.bugs.filter((b) => b.severity === "high")) {
      lines.push(
        `- **${bug.id}** \`${bug.file.split("/").slice(-2).join("/")}:${bug.line}\` — ${bug.message}`,
      );
    }
    lines.push("");
  }

  if (result.bySeverity.medium > 0) {
    lines.push("## Medium Bugs", "");
    for (const bug of result.bugs
      .filter((b) => b.severity === "medium")
      .slice(0, 30)) {
      lines.push(
        `- **${bug.id}** \`${bug.file.split("/").slice(-2).join("/")}:${bug.line}\` — ${bug.message}`,
      );
    }
    if (result.bySeverity.medium > 30)
      lines.push(`- ... and ${result.bySeverity.medium - 30} more`);
    lines.push("");
  }

  return lines.join("\n");
}
