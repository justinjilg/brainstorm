/**
 * SWE-bench run scorecard — persists a per-run artifact (JSON + human
 * readable summary) under `~/.brainstorm/swebench/<runId>/` given
 * per-instance results (resolved bool, cost, patch size).
 *
 * This is deliberately independent of `scorer.ts`'s Docker-driven
 * `SWEBenchScorecard` (which reports pytest pass/fail counts for a single
 * in-memory run). `RunScorecard` here is the artifact format for a full
 * baseline/subset run — e.g. a `--split verified --limit N --seed S`
 * selection — that gets written to disk for later comparison across runs.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/** Per-instance result feeding into a run scorecard. */
export interface SWEBenchInstanceResult {
  instanceId: string;
  resolved: boolean;
  /** Cost of the agent run for this instance, in USD. */
  cost: number;
  /** Size of the generated patch in bytes (0 if no patch was produced). */
  patchSizeBytes: number;
  latencyMs?: number;
  error?: string;
}

/** Aggregate scorecard for a full SWE-bench run/subset. */
export interface SWEBenchRunScorecard {
  runId: string;
  split: string;
  createdAt: number;
  total: number;
  resolved: number;
  /** Fraction in [0, 1]. Use `resolvedRate * 100` for a percentage. */
  resolvedRate: number;
  totalCost: number;
  avgCost: number;
  avgPatchSizeBytes: number;
  results: SWEBenchInstanceResult[];
}

const SWEBENCH_DIR = join(homedir(), ".brainstorm", "swebench");

/** Generate a fresh run id (timestamp + short random suffix). */
export function generateRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

/** Directory a given run's artifacts live/should be written under. */
export function getRunDir(runId: string): string {
  return join(SWEBENCH_DIR, runId);
}

/**
 * Build a `SWEBenchRunScorecard` from per-instance results. Pure function —
 * does no I/O.
 */
export function buildRunScorecard(
  runId: string,
  split: string,
  results: SWEBenchInstanceResult[],
): SWEBenchRunScorecard {
  const total = results.length;
  const resolved = results.filter((r) => r.resolved).length;
  const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
  const totalPatchSize = results.reduce((sum, r) => sum + r.patchSizeBytes, 0);

  return {
    runId,
    split,
    createdAt: Date.now(),
    total,
    resolved,
    resolvedRate: total > 0 ? resolved / total : 0,
    totalCost,
    avgCost: total > 0 ? totalCost / total : 0,
    avgPatchSizeBytes: total > 0 ? Math.round(totalPatchSize / total) : 0,
    results,
  };
}

/**
 * Format a run scorecard as a human-readable summary, including a
 * per-instance table.
 */
export function formatRunScorecard(scorecard: SWEBenchRunScorecard): string {
  const lines = [
    "=== SWE-bench Run Scorecard ===",
    "",
    `Run ID: ${scorecard.runId}`,
    `Split: ${scorecard.split}`,
    `Created: ${new Date(scorecard.createdAt).toISOString()}`,
    "",
    `Total instances: ${scorecard.total}`,
    `Resolved: ${scorecard.resolved} (${(scorecard.resolvedRate * 100).toFixed(1)}%)`,
    `Total cost: $${scorecard.totalCost.toFixed(4)}`,
    `Avg cost/instance: $${scorecard.avgCost.toFixed(4)}`,
    `Avg patch size: ${scorecard.avgPatchSizeBytes} bytes`,
    "",
    "Per-instance results:",
    "  status    cost      patch(b)  instance_id",
    "  --------  --------  --------  -----------",
  ];

  for (const r of scorecard.results) {
    const status = r.resolved ? "PASS" : "FAIL";
    const cost = `$${r.cost.toFixed(4)}`.padEnd(8);
    const patch = String(r.patchSizeBytes).padEnd(8);
    const suffix = r.error ? ` (${r.error})` : "";
    lines.push(
      `  ${status.padEnd(8)}  ${cost}  ${patch}  ${r.instanceId}${suffix}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

/** Paths written by `writeRunScorecard`. */
export interface WrittenScorecardPaths {
  runDir: string;
  jsonPath: string;
  summaryPath: string;
}

/**
 * Write a run scorecard's JSON + human-readable summary artifacts to
 * `~/.brainstorm/swebench/<runId>/`. Returns the paths written.
 */
export function writeRunScorecard(
  scorecard: SWEBenchRunScorecard,
): WrittenScorecardPaths {
  const runDir = getRunDir(scorecard.runId);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }

  const jsonPath = join(runDir, "scorecard.json");
  const summaryPath = join(runDir, "summary.txt");

  writeFileSync(jsonPath, JSON.stringify(scorecard, null, 2), "utf-8");
  writeFileSync(summaryPath, formatRunScorecard(scorecard), "utf-8");

  return { runDir, jsonPath, summaryPath };
}

export { SWEBENCH_DIR };
