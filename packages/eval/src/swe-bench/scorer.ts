/**
 * SWE-bench Scorer — run gold tests against generated patches.
 */

import type { SWEBenchInstance, SWEBenchPatch } from './runner.js';

export interface SWEBenchScore {
  instanceId: string;
  passed: boolean;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  error?: string;
}

export interface SWEBenchScorecard {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  totalCost: number;
  avgLatencyMs: number;
  scores: SWEBenchScore[];
}

/**
 * Score patches against gold test results.
 * In a full implementation, this would:
 * 1. Apply each patch to the repo at baseCommit
 * 2. Run the gold tests (testPatch)
 * 3. Check if tests pass
 *
 * For now, returns a scorecard structure ready for full integration.
 */
export function scorePatch(
  instance: SWEBenchInstance,
  patch: SWEBenchPatch,
): SWEBenchScore {
  // Placeholder: full scoring requires Docker + git apply + test execution
  // This structure is ready for integration with the SWE-bench harness
  return {
    instanceId: instance.instanceId,
    passed: patch.success && patch.patch.length > 0,
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
  };
}

/**
 * Generate a scorecard from evaluation results.
 */
export function generateScorecard(
  patches: SWEBenchPatch[],
  scores: SWEBenchScore[],
): SWEBenchScorecard {
  const passed = scores.filter((s) => s.passed).length;
  const failed = scores.filter((s) => !s.passed && !s.error).length;
  const errored = scores.filter((s) => s.error).length;

  const totalCost = patches.reduce((sum, p) => sum + p.cost, 0);
  const avgLatency = patches.length > 0
    ? patches.reduce((sum, p) => sum + p.latencyMs, 0) / patches.length
    : 0;

  return {
    total: scores.length,
    passed,
    failed,
    errored,
    passRate: scores.length > 0 ? passed / scores.length : 0,
    totalCost,
    avgLatencyMs: Math.round(avgLatency),
    scores,
  };
}
