/**
 * Convention Monitor Middleware — detects convention drift in file edits.
 *
 * After file_write/file_edit, checks basic coding conventions:
 * - Naming patterns (camelCase vs snake_case)
 * - Semicolon usage
 * - Import style
 * - Quote style
 *
 * Conventions are loaded from project memory (populated by onboard pipeline).
 * When drift is detected, logs a warning. The quality signal helps KAIROS
 * detect when agents are ignoring project conventions.
 */

import type { AgentMiddleware, MiddlewareToolResult } from "../types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("convention-monitor");

const WRITE_TOOLS = new Set([
  "file_write",
  "file_edit",
  "multi_edit",
  "batch_edit",
]);

interface ConventionCheck {
  name: string;
  /** Returns true if the content violates the convention. */
  check: (content: string, convention: string) => boolean;
}

const CHECKS: ConventionCheck[] = [
  {
    name: "snake_case in camelCase project",
    check: (content, convention) => {
      if (!convention.toLowerCase().includes("camelcase")) return false;
      // Check for snake_case variable declarations (but not constants or imports)
      const snakePattern = /(?:let|const|var)\s+[a-z]+_[a-z]+/;
      return snakePattern.test(content);
    },
  },
  {
    name: "missing semicolons in semicolon-required project",
    check: (content, convention) => {
      if (
        !convention.toLowerCase().includes("always") ||
        !convention.toLowerCase().includes("semicolon")
      )
        return false;
      // Check for lines ending without semicolons (rough heuristic)
      const lines = content
        .split("\n")
        .filter(
          (l) =>
            l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*"),
        );
      const noSemiCount = lines.filter(
        (l) =>
          /^(import|export|const|let|var|return|throw)\s/.test(l.trim()) &&
          !l.trimEnd().endsWith(";") &&
          !l.trimEnd().endsWith("{") &&
          !l.trimEnd().endsWith(","),
      ).length;
      return noSemiCount > 3; // Tolerate a few — don't be noisy
    },
  },
  {
    name: "double quotes in single-quote project",
    check: (content, convention) => {
      if (!convention.toLowerCase().includes("single")) return false;
      const doubleQuoteImports = (content.match(/from\s+"[^"]+"/g) || [])
        .length;
      const singleQuoteImports = (content.match(/from\s+'[^']+'/g) || [])
        .length;
      return doubleQuoteImports > singleQuoteImports && doubleQuoteImports > 2;
    },
  },
];

export function createConventionMonitorMiddleware(
  projectPath?: string,
): AgentMiddleware {
  let conventions: string | null = null;
  let conventionsLoaded = false;
  let driftCount = 0;

  return {
    name: "convention-monitor",

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      if (!WRITE_TOOLS.has(result.name)) return;

      // Lazy-load conventions from memory on first write
      if (!conventionsLoaded && projectPath) {
        conventionsLoaded = true;
        try {
          // Dynamic import to avoid circular dependency
          const { MemoryManager } = require("@brainst0rm/core");
          const memory = new MemoryManager(projectPath);
          const entries = memory.search("conventions");
          if (entries.length > 0) {
            conventions = entries[0].content;
          }
        } catch {
          // Memory not available — skip convention checking
        }
      }

      if (!conventions) return;

      // Extract content from tool result
      const output = result.output as any;
      const content =
        typeof output === "string"
          ? output
          : (output?.content ?? output?.newContent ?? "");
      if (!content || typeof content !== "string") return;

      for (const check of CHECKS) {
        if (check.check(content, conventions)) {
          driftCount++;
          log.warn(
            { check: check.name, tool: result.name, driftCount },
            "Convention drift detected in file edit",
          );
          break; // One drift event per tool call
        }
      }
    },
  };
}
