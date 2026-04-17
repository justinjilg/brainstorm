import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  ProbeResult,
  EvalRun,
  CapabilityDimension,
  CapabilityScorecard,
} from "./types.js";

const EVAL_DIR = join(homedir(), ".brainstorm", "eval");

/**
 * Ensure the eval storage directory exists.
 */
function ensureDir(): void {
  if (!existsSync(EVAL_DIR)) {
    mkdirSync(EVAL_DIR, { recursive: true });
  }
}

/**
 * Create an EvalRun from probe results and persist it.
 */
export function saveEvalRun(modelId: string, results: ProbeResult[]): EvalRun {
  ensureDir();

  // Math.min(...[]) === Infinity, which JSON.stringify serializes as `null`
  // and downstream arithmetic turns into NaN. Guard against empty results
  // (no probes ran / all probes filtered) by falling back to the current
  // time — the run just has startedAt == completedAt.
  const now = Date.now();
  const startedAt = results.length
    ? Math.min(...results.map((r) => now - r.durationMs))
    : now;
  const run: EvalRun = {
    id: randomUUID().slice(0, 8),
    modelId,
    startedAt,
    completedAt: now,
    results,
    scores: computeScores(results),
    totalCost: results.reduce((sum, r) => sum + r.cost, 0),
  };

  // Append as JSONL
  const runPath = join(EVAL_DIR, "runs.jsonl");
  appendFileSync(runPath, JSON.stringify(run) + "\n", "utf-8");

  return run;
}

/**
 * Compute aggregate scores per capability dimension.
 */
function computeScores(
  results: ProbeResult[],
): Record<CapabilityDimension, number> {
  const dimensions: CapabilityDimension[] = [
    "tool-selection",
    "tool-sequencing",
    "code-correctness",
    "multi-step",
    "instruction-adherence",
    "context-utilization",
    "self-correction",
  ];

  const scores = {} as Record<CapabilityDimension, number>;

  for (const dim of dimensions) {
    const dimResults = results.filter((r) => r.capability === dim);
    if (dimResults.length === 0) {
      scores[dim] = 0;
    } else {
      scores[dim] =
        dimResults.filter((r) => r.passed).length / dimResults.length;
    }
  }

  return scores;
}

/**
 * Build a capability scorecard from an eval run.
 */
export function buildScorecard(run: EvalRun): CapabilityScorecard {
  const dimensions = {} as CapabilityScorecard["dimensions"];

  for (const [dim, score] of Object.entries(run.scores)) {
    const dimResults = run.results.filter((r) => r.capability === dim);
    dimensions[dim as CapabilityDimension] = {
      score,
      passed: dimResults.filter((r) => r.passed).length,
      total: dimResults.length,
    };
  }

  const totalPassed = run.results.filter((r) => r.passed).length;

  return {
    modelId: run.modelId,
    evaluatedAt: run.completedAt ?? Date.now(),
    dimensions,
    overall: {
      score: run.results.length > 0 ? totalPassed / run.results.length : 0,
      passed: totalPassed,
      total: run.results.length,
      cost: run.totalCost,
    },
  };
}

/**
 * Load all eval runs from storage.
 */
export function loadEvalRuns(): EvalRun[] {
  const runPath = join(EVAL_DIR, "runs.jsonl");
  if (!existsSync(runPath)) return [];

  const runs: EvalRun[] = [];
  const lines = readFileSync(runPath, "utf-8").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      runs.push(JSON.parse(line) as EvalRun);
    } catch {
      // Skip corrupted lines — don't let one bad line block all eval history
    }
  }

  return runs;
}

/**
 * Get the latest scorecard for a model.
 */
export function getLatestScorecard(
  modelId: string,
): CapabilityScorecard | null {
  const runs = loadEvalRuns().filter((r) => r.modelId === modelId);
  if (runs.length === 0) return null;
  const latest = runs[runs.length - 1];
  return buildScorecard(latest);
}

export { EVAL_DIR };
