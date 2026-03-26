/**
 * SWE-bench Reporter — format evaluation results for display.
 */

import type { SWEBenchScorecard } from './scorer.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Format a scorecard for console display.
 */
export function formatScorecard(scorecard: SWEBenchScorecard): string {
  const lines = [
    '=== SWE-bench Evaluation Results ===',
    '',
    `Total instances: ${scorecard.total}`,
    `Passed: ${scorecard.passed} (${(scorecard.passRate * 100).toFixed(1)}%)`,
    `Failed: ${scorecard.failed}`,
    `Errored: ${scorecard.errored}`,
    '',
    `Total cost: $${scorecard.totalCost.toFixed(2)}`,
    `Avg latency: ${scorecard.avgLatencyMs}ms`,
    `Cost per instance: $${scorecard.total > 0 ? (scorecard.totalCost / scorecard.total).toFixed(3) : '0.000'}`,
    '',
  ];

  // Per-instance breakdown (top 10 failures)
  const failures = scorecard.scores.filter((s) => !s.passed);
  if (failures.length > 0) {
    lines.push(`Failed instances (${failures.length}):`);
    for (const f of failures.slice(0, 10)) {
      lines.push(`  - ${f.instanceId}${f.error ? `: ${f.error}` : ''}`);
    }
    if (failures.length > 10) {
      lines.push(`  ... and ${failures.length - 10} more`);
    }
  }

  return lines.join('\n');
}

/**
 * Save scorecard as JSON report.
 */
export function saveReport(scorecard: SWEBenchScorecard, outputDir: string): string {
  const reportPath = join(outputDir, `swe-bench-report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(scorecard, null, 2));
  return reportPath;
}
