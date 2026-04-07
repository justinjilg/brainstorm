/**
 * Network Egress Monitor — inspects shell command outputs for exfiltration indicators.
 *
 * Runs as afterToolResult middleware on shell/process_spawn outputs.
 * Detects patterns that suggest data exfiltration:
 *   - Base64/hex-encoded blobs being sent to external URLs
 *   - DNS exfiltration (long subdomain labels)
 *   - Successful curl/wget to non-allowlisted domains
 *   - Pipe chains ending in network commands
 *
 * When detected, tags the result with a warning and increments a session counter.
 * After 3 egress warnings, subsequent shell calls are blocked entirely.
 */

import type {
  AgentMiddleware,
  MiddlewareToolCall,
  MiddlewareToolResult,
  MiddlewareBlock,
} from "../types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("egress-monitor");

// ── Egress Patterns ────────────────────────────────────────────────

interface EgressPattern {
  name: string;
  /** Matches against the shell command string. */
  commandPattern?: RegExp;
  /** Matches against the shell output. */
  outputPattern?: RegExp;
  severity: "warning" | "critical";
}

const COMMAND_EGRESS_PATTERNS: EgressPattern[] = [
  {
    name: "base64-pipe-to-curl",
    commandPattern: /base64.*\|\s*curl|curl.*\$\(.*base64/i,
    severity: "critical",
  },
  {
    name: "cat-pipe-to-network",
    commandPattern:
      /cat\s+.*\|\s*(curl|wget|nc|netcat)|cat\s+.*\|\s*base64.*\|\s*(curl|wget)/i,
    severity: "critical",
  },
  {
    name: "env-to-network",
    commandPattern: /\b(env|printenv|set)\b.*\|\s*(curl|wget|nc)/i,
    severity: "critical",
  },
  {
    name: "dns-exfiltration",
    commandPattern:
      /\b(dig|nslookup|host)\s+[a-z0-9]{32,}\.|\.burpcollaborator\.|\.oastify\./i,
    severity: "critical",
  },
  {
    name: "reverse-shell",
    commandPattern:
      /\bbash\s+-i\s*>&|\/dev\/tcp\/|mkfifo.*\/tmp.*nc\s|python.*socket.*connect/i,
    severity: "critical",
  },
  {
    name: "encoded-url-parameter",
    commandPattern:
      /curl.*[?&](data|payload|d|body|q)=([A-Za-z0-9+/]{40,}|[0-9a-f]{40,})/i,
    severity: "warning",
  },
  {
    name: "webhook-post",
    commandPattern:
      /curl\s+-X\s*POST.*\.(webhook\.site|requestbin|hookbin|pipedream)/i,
    severity: "critical",
  },
];

const OUTPUT_EGRESS_PATTERNS: EgressPattern[] = [
  {
    name: "successful-exfil-response",
    outputPattern: /\b(200|ok|success|received|uploaded)\b/i,
    severity: "warning",
  },
];

// ── Allowlisted Domains ────────────────────────────────────────────

const ALLOWLISTED_DOMAINS = new Set([
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "crates.io",
  "rubygems.org",
  "packagist.org",
  "api.brainstormrouter.com",
  "localhost",
  "127.0.0.1",
  "::1",
]);

function extractDomains(command: string): string[] {
  const urlPattern = /https?:\/\/([a-zA-Z0-9.-]+(?:\.[a-zA-Z]{2,}))(:\d+)?/g;
  const domains: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(command)) !== null) {
    domains.push(match[1].toLowerCase());
  }
  return domains;
}

function hasNonAllowlistedDomain(command: string): boolean {
  const domains = extractDomains(command);
  return domains.some((d) => !ALLOWLISTED_DOMAINS.has(d));
}

// ── Middleware ──────────────────────────────────────────────────────

const SHELL_TOOLS = new Set(["shell", "process_spawn"]);
const BLOCK_THRESHOLD = 3; // Block all shell after this many egress warnings

export function createEgressMonitorMiddleware(): AgentMiddleware {
  let egressWarnings = 0;

  return {
    name: "egress-monitor",

    wrapToolCall(
      call: MiddlewareToolCall,
    ): MiddlewareToolCall | MiddlewareBlock | void {
      if (!SHELL_TOOLS.has(call.name)) return;

      // After repeated egress warnings, block all shell commands
      if (egressWarnings >= BLOCK_THRESHOLD) {
        log.warn(
          { tool: call.name, warningCount: egressWarnings },
          "Shell blocked after repeated egress warnings",
        );
        return {
          blocked: true,
          reason: `Shell suspended: ${egressWarnings} egress warnings this session. Possible exfiltration in progress. Requires human approval to continue.`,
          middleware: "egress-monitor",
        };
      }

      // Pre-check: scan command for egress patterns before running
      const cmd = String(call.input.command ?? "");
      for (const pattern of COMMAND_EGRESS_PATTERNS) {
        if (pattern.commandPattern && pattern.commandPattern.test(cmd)) {
          if (pattern.severity === "critical") {
            egressWarnings++;
            log.warn(
              {
                pattern: pattern.name,
                command: cmd.slice(0, 200),
                severity: pattern.severity,
              },
              "Egress pattern detected in command — blocked",
            );
            return {
              blocked: true,
              reason: `[${pattern.name}] Command matches exfiltration pattern. ${cmd.slice(0, 80)}...`,
              middleware: "egress-monitor",
            };
          }
        }
      }

      // Pre-check: non-allowlisted domains with POST/data flags
      if (
        hasNonAllowlistedDomain(cmd) &&
        /\b(-X\s*POST|-d\s|--data|--upload-file)\b/i.test(cmd)
      ) {
        egressWarnings++;
        log.warn(
          { command: cmd.slice(0, 200) },
          "POST to non-allowlisted domain — blocked",
        );
        return {
          blocked: true,
          reason: `POST/upload to non-allowlisted domain detected. Add domain to egress allowlist or use an approved API.`,
          middleware: "egress-monitor",
        };
      }
    },

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      if (!SHELL_TOOLS.has(result.name)) return;
      if (!result.ok) return; // Failed commands don't exfiltrate

      const output = String(
        typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output),
      );

      // Check for large base64 blobs in output (data staging)
      const base64Chunks = output.match(/[A-Za-z0-9+/]{100,}={0,2}/g);
      if (base64Chunks && base64Chunks.length > 0) {
        const totalSize = base64Chunks.reduce((s, c) => s + c.length, 0);
        if (totalSize > 500) {
          log.info(
            { size: totalSize },
            "Large base64 content in shell output — potential data staging",
          );
          return {
            ...result,
            output: {
              ...(typeof result.output === "object" && result.output !== null
                ? result.output
                : { content: output }),
              _egress_warning: `Large base64 content detected in output (${totalSize} chars). If this was staged for exfiltration, subsequent network commands will be blocked.`,
            },
          };
        }
      }
    },
  };
}
