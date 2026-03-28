/**
 * Security scanning middleware — automatically scans file writes for secrets.
 *
 * Inspired by Copilot's CodeQL + secret scanning pipeline.
 * Runs afterToolResult for file_write, file_edit, and git_commit.
 */

import type { AgentMiddleware, MiddlewareToolResult } from "../types.js";
import {
  scanForCredentials,
  redactCredentials,
} from "../../security/secret-scanner.js";

const WRITE_TOOLS = new Set([
  "file_write",
  "file_edit",
  "multi_edit",
  "batch_edit",
]);

const COMMIT_TOOLS = new Set(["git_commit"]);

/**
 * Create security scanning middleware.
 * Scans written content for credentials after every file write.
 */
export function createSecurityScanMiddleware(): AgentMiddleware {
  let sessionFindingCount = 0;

  return {
    name: "security-scan",

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      const { name: toolName, output } = result;

      if (WRITE_TOOLS.has(toolName)) {
        const content = extractContent(output);
        if (!content) return;

        const scan = scanForCredentials(content);
        if (scan.hasFindings) {
          sessionFindingCount += scan.findings.length;

          const warning = [
            "⚠ SECURITY: Potential credentials detected in written content:",
            ...scan.findings.map(
              (f) =>
                `  • ${f.name}: ${redactCredentials(f.preview).slice(0, 60)}`,
            ),
            "  Remove or use environment variables / vault before committing.",
          ].join("\n");

          return {
            ...result,
            output: {
              ...(typeof output === "object" && output !== null ? output : {}),
              _security_warning: warning,
              _credentials_detected: scan.findings.length,
            },
          };
        }
      }

      if (COMMIT_TOOLS.has(toolName) && sessionFindingCount > 0) {
        return {
          ...result,
          output: {
            ...(typeof output === "object" && output !== null ? output : {}),
            _security_warning: `⚠ WARNING: ${sessionFindingCount} potential credential(s) detected in files written this session. Review before pushing.`,
          },
        };
      }
    },
  };
}

function extractContent(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (typeof output === "object" && output !== null) {
    const o = output as Record<string, unknown>;
    if (typeof o.content === "string") return o.content;
    if (typeof o.newContent === "string") return o.newContent;
    if (typeof o.new_string === "string") return o.new_string;
  }
  return null;
}
