/**
 * Convention Enforcement Middleware — project-configurable rules.
 *
 * Inspired by CyberFabric's dylint architectural lints. Deterministic rules
 * that enforce project conventions without LLM calls.
 *
 * Rules are loaded from config (brainstorm.toml conventions section).
 * Each rule runs against tool call inputs/outputs and produces warnings
 * or blocks when violations are detected.
 */

import type {
  AgentMiddleware,
  MiddlewareToolCall,
  MiddlewareToolResult,
  MiddlewareBlock,
} from "../types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("convention-enforce");

export interface ConventionRule {
  /** Rule identifier. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Severity: error blocks the tool call, warning logs. */
  severity: "error" | "warning";
  /** Which tools this rule applies to (regex on tool name). */
  toolMatcher: string;
  /** The check function — returns violation message or null. */
  check: (input: Record<string, unknown>) => string | null;
}

// ── Built-in Rules ────────────────────────────────────────────────

/**
 * Rule: No direct .env file writes (secrets should use vault).
 */
const noEnvFileWrites: ConventionRule = {
  id: "no-env-writes",
  description: "Prevent writing to .env files — use vault for secrets",
  severity: "error",
  toolMatcher: "file_write|file_edit",
  check: (input) => {
    const path = String(input.path ?? input.file_path ?? "");
    if (path.match(/\.env(\.|$)/)) {
      return `Writing to ${path} is blocked. Store secrets in the vault, not .env files.`;
    }
    return null;
  },
};

/**
 * Rule: No console.log in production code.
 */
const noConsoleLog: ConventionRule = {
  id: "no-console-log",
  description: "Warn on console.log — use structured logging instead",
  severity: "warning",
  toolMatcher: "file_write|file_edit",
  check: (input) => {
    const content = String(input.content ?? input.new_string ?? "");
    if (
      content.includes("console.log(") &&
      !content.includes("// eslint-disable")
    ) {
      return "console.log() detected — use structured logging (createLogger) instead.";
    }
    return null;
  },
};

/**
 * Rule: Require tenant scoping in database queries.
 */
const requireTenantScope: ConventionRule = {
  id: "require-tenant-scope",
  description: "Warn when SQL queries lack tenant/org scoping",
  severity: "warning",
  toolMatcher: "file_write|file_edit",
  check: (input) => {
    const content = String(input.content ?? input.new_string ?? "");
    // Look for SQL queries without WHERE clause or without org_id/tenant_id
    const sqlPatterns = content.match(
      /(?:SELECT|UPDATE|DELETE)\s+.*\s+FROM\s+\w+(?:\s|;)/gi,
    );
    if (sqlPatterns) {
      for (const sql of sqlPatterns) {
        if (
          !sql.toLowerCase().includes("where") &&
          !sql.toLowerCase().includes("join")
        ) {
          return `SQL query without WHERE clause: "${sql.trim().slice(0, 80)}". Ensure tenant scoping.`;
        }
      }
    }
    return null;
  },
};

/**
 * Rule: Max file length warning.
 */
const maxFileLength: ConventionRule = {
  id: "max-file-length",
  description: "Warn when creating files over 500 lines",
  severity: "warning",
  toolMatcher: "file_write",
  check: (input) => {
    const content = String(input.content ?? "");
    const lines = content.split("\n").length;
    if (lines > 500) {
      return `File is ${lines} lines — consider splitting into smaller modules.`;
    }
    return null;
  },
};

/**
 * Rule: No hardcoded API keys/tokens.
 */
const noHardcodedSecrets: ConventionRule = {
  id: "no-hardcoded-secrets",
  description: "Block hardcoded API keys and tokens",
  severity: "error",
  toolMatcher: "file_write|file_edit",
  check: (input) => {
    const content = String(input.content ?? input.new_string ?? "");
    // Common patterns for hardcoded secrets
    const patterns = [
      /(?:api[_-]?key|apikey|api_secret)\s*[:=]\s*["'][a-zA-Z0-9]{20,}["']/i,
      /(?:sk-|pk_|rk_)[a-zA-Z0-9]{20,}/,
      /Bearer\s+[a-zA-Z0-9._-]{30,}/,
    ];
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return "Hardcoded API key or token detected. Use $VAULT_* patterns or environment variables.";
      }
    }
    return null;
  },
};

/** Default built-in rules. */
export const BUILTIN_RULES: ConventionRule[] = [
  noEnvFileWrites,
  noConsoleLog,
  requireTenantScope,
  maxFileLength,
  noHardcodedSecrets,
];

// ── Middleware ─────────────────────────────────────────────────────

export function createConventionEnforcementMiddleware(
  customRules?: ConventionRule[],
): AgentMiddleware {
  const rules = [...BUILTIN_RULES, ...(customRules ?? [])];
  // Pre-compile matchers
  const compiledRules = rules.map((r) => ({
    ...r,
    matcher: new RegExp(r.toolMatcher),
  }));

  return {
    name: "convention-enforcement",

    wrapToolCall(
      call: MiddlewareToolCall,
    ): MiddlewareToolCall | MiddlewareBlock | void {
      for (const rule of compiledRules) {
        if (!rule.matcher.test(call.name)) continue;

        const violation = rule.check(call.input);
        if (!violation) continue;

        if (rule.severity === "error") {
          log.warn({ rule: rule.id, tool: call.name }, violation);
          return {
            blocked: true,
            reason: `[${rule.id}] ${violation}`,
            middleware: "convention-enforcement",
          };
        }

        // Warning — log but don't block
        log.info({ rule: rule.id, tool: call.name }, violation);
      }
    },
  };
}
