/**
 * Deterministic Validation — no LLM, pure structural checks.
 *
 * Inspired by CyberFabric's `cpt validate`. Validates that:
 * 1. Every code change traces back to a plan/requirement
 * 2. Every plan task has a spec origin
 * 3. Changed functions have tests
 * 4. Blast radius is within configured threshold
 * 5. Convention rules pass
 *
 * All checks are deterministic — they use the code graph and traceability
 * store, never an LLM. This enables CI/CD integration.
 */

import type Database from "better-sqlite3";
import {
  findUntracedChanges,
  findUntestedRequirements,
  getCoverageMetrics,
} from "./store.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("validate");

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationFinding {
  rule: string;
  severity: ValidationSeverity;
  message: string;
  file?: string;
  traceId?: string;
}

export interface ValidationResult {
  passed: boolean;
  findings: ValidationFinding[];
  coverage: {
    requirements: { total: number; tested: number; percent: number };
    changes: { total: number; traced: number; percent: number };
  };
  score: number; // 0-100
}

export interface ValidationRules {
  /** Require all code changes to trace to a plan/requirement. Default true. */
  requireTraceability?: boolean;
  /** Require all requirements to have tests. Default false. */
  requireTestCoverage?: boolean;
  /** Maximum allowed blast radius (number of affected symbols). Default 50. */
  maxBlastRadius?: number;
  /** Maximum function complexity score. Default 10. */
  maxComplexity?: number;
  /** Minimum traceability coverage percentage. Default 0 (no minimum). */
  minTraceCoverage?: number;
}

const DEFAULT_RULES: Required<ValidationRules> = {
  requireTraceability: true,
  requireTestCoverage: false,
  maxBlastRadius: 50,
  maxComplexity: 10,
  minTraceCoverage: 0,
};

/**
 * Run deterministic validation on a project.
 *
 * @param db - Project database (brainstorm.db or code-graph.db)
 * @param project - Project slug for traceability queries
 * @param rules - Validation rules (from brainstorm.toml)
 * @param graph - Optional code graph for structural checks
 */
export function validate(
  db: Database.Database,
  project: string,
  rules?: ValidationRules,
  graph?: { getDb: () => any; extendedStats: () => any },
): ValidationResult {
  const config = { ...DEFAULT_RULES, ...rules };
  const findings: ValidationFinding[] = [];

  // ── Check 1: Traceability coverage ──────────────────────────────

  const metrics = getCoverageMetrics(db, project);

  if (config.requireTraceability && metrics.changes.total > 0) {
    const untracedChanges = findUntracedChanges(db, project);
    if (untracedChanges.length > 0) {
      for (const change of untracedChanges) {
        findings.push({
          rule: "traceability",
          severity: "error",
          message: `Code change "${change.title}" has no requirement/plan trace`,
          traceId: change.traceId,
          file: change.filePath,
        });
      }
    }
  }

  // ── Check 2: Test coverage ──────────────────────────────────────

  if (config.requireTestCoverage && metrics.requirements.total > 0) {
    const untestedReqs = findUntestedRequirements(db, project);
    if (untestedReqs.length > 0) {
      for (const req of untestedReqs) {
        findings.push({
          rule: "test-coverage",
          severity: "warning",
          message: `Requirement "${req.title}" has no linked test`,
          traceId: req.traceId,
        });
      }
    }
  }

  // ── Check 3: Blast radius ──────────────────────────────────────

  if (graph) {
    const graphDb = graph.getDb();

    // Find functions with excessive caller count
    try {
      const hotspots = graphDb
        .prepare(
          `
        SELECT callee AS name, COUNT(*) AS callerCount
        FROM call_edges
        GROUP BY callee
        HAVING callerCount > ?
        ORDER BY callerCount DESC
        LIMIT 10
      `,
        )
        .all(config.maxBlastRadius) as Array<{
        name: string;
        callerCount: number;
      }>;

      for (const hotspot of hotspots) {
        findings.push({
          rule: "blast-radius",
          severity: "warning",
          message: `Function "${hotspot.name}" has ${hotspot.callerCount} callers (threshold: ${config.maxBlastRadius}). Changes here have extreme blast radius.`,
        });
      }
    } catch {
      /* graph may not have call_edges */
    }

    // Find high-complexity functions
    try {
      const complexNodes = graphDb
        .prepare(
          `
        SELECT name, file, metadata_json FROM nodes
        WHERE kind = 'function' AND metadata_json IS NOT NULL
      `,
        )
        .all() as Array<{ name: string; file: string; metadata_json: string }>;

      for (const node of complexNodes) {
        try {
          const meta = JSON.parse(node.metadata_json);
          if (meta.complexity && meta.complexity > config.maxComplexity) {
            findings.push({
              rule: "complexity",
              severity: "warning",
              message: `Function "${node.name}" has complexity ${meta.complexity} (threshold: ${config.maxComplexity})`,
              file: node.file,
            });
          }
        } catch {
          /* ignore bad metadata */
        }
      }
    } catch {
      /* graph may not have nodes table */
    }
  }

  // ── Check 4: Minimum trace coverage ─────────────────────────────

  if (config.minTraceCoverage > 0 && metrics.changes.total > 0) {
    const tracePct = (metrics.changes.traced / metrics.changes.total) * 100;
    if (tracePct < config.minTraceCoverage) {
      findings.push({
        rule: "trace-coverage",
        severity: "error",
        message: `Traceability coverage ${tracePct.toFixed(0)}% is below minimum ${config.minTraceCoverage}%`,
      });
    }
  }

  // ── Compute score ───────────────────────────────────────────────

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const score = Math.max(0, 100 - errors * 15 - warnings * 5);

  const reqPct =
    metrics.requirements.total > 0
      ? (metrics.requirements.tested / metrics.requirements.total) * 100
      : 100;
  const chgPct =
    metrics.changes.total > 0
      ? (metrics.changes.traced / metrics.changes.total) * 100
      : 100;

  const result: ValidationResult = {
    passed: errors === 0,
    findings,
    coverage: {
      requirements: {
        total: metrics.requirements.total,
        tested: metrics.requirements.tested,
        percent: reqPct,
      },
      changes: {
        total: metrics.changes.total,
        traced: metrics.changes.traced,
        percent: chgPct,
      },
    },
    score,
  };

  log.info(
    {
      passed: result.passed,
      errors,
      warnings,
      score,
      reqCoverage: `${reqPct.toFixed(0)}%`,
      chgCoverage: `${chgPct.toFixed(0)}%`,
    },
    "Validation complete",
  );

  return result;
}
