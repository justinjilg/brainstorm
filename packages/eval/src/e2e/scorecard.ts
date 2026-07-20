import type {
  AxisScore,
  E2EScorecard,
  E2ETrialResult,
  ScoreAxis,
} from "./types.js";

const AXES: ScoreAxis[] = [
  "correctness",
  "quality",
  "efficiency",
  "resilience",
  "governance",
];

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Wilson score interval at 95% confidence for a binary pass proportion. */
export function wilsonInterval(
  passed: number,
  total: number,
): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 0 };
  const z = 1.959963984540054;
  const p = passed / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function scoreAxis(results: E2ETrialResult[], axis: ScoreAxis): AxisScore {
  const values = results
    .map((result) => result[axis])
    .filter((value): value is number => value !== undefined)
    .map(clampScore);
  if (values.length === 0) {
    return { mean: 0, samples: 0, passRate: 0, passLower95: 0, passUpper95: 0 };
  }
  const passed = values.filter((value) => value >= 0.9).length;
  const interval = wilsonInterval(passed, values.length);
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    samples: values.length,
    passRate: passed / values.length,
    passLower95: interval.lower,
    passUpper95: interval.upper,
  };
}

export function buildE2EScorecard(
  suiteId: string,
  trialsPerTask: number,
  results: E2ETrialResult[],
  generatedAt = Date.now(),
): E2EScorecard {
  const taskCount = new Set(results.map((result) => result.taskId)).size;
  const recoveryCases = results.filter(
    (result) => result.recovered || result.attempts > 1,
  );
  const axes = {} as Record<ScoreAxis, AxisScore>;
  for (const axis of AXES) axes[axis] = scoreAxis(results, axis);

  return {
    suiteId,
    generatedAt,
    trialsPerTask,
    taskCount,
    resultCount: results.length,
    axes,
    verifiedCompletionRate:
      results.length === 0
        ? 0
        : results.filter(
            (result) =>
              result.status === "succeeded" && result.correctness >= 0.9,
          ).length / results.length,
    usableTerminalRate:
      results.length === 0
        ? 0
        : results.filter(
            (result) =>
              result.status === "succeeded" || result.status === "failed",
          ).length / results.length,
    recoverySuccessRate:
      recoveryCases.length === 0
        ? null
        : recoveryCases.filter(
            (result) =>
              result.status === "succeeded" && result.resilience >= 0.9,
          ).length / recoveryCases.length,
    silentFailureRate:
      results.length === 0
        ? 0
        : results.filter((result) => result.silentFailure).length /
          results.length,
    stateCorruptionRate:
      results.length === 0
        ? 0
        : results.filter((result) => result.stateCorruption).length /
          results.length,
    totalCostUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    meanDurationMs:
      results.length === 0
        ? 0
        : results.reduce((sum, result) => sum + result.durationMs, 0) /
          results.length,
  };
}

export function formatE2EScorecard(scorecard: E2EScorecard): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `=== Brainstorm E2E Scorecard: ${scorecard.suiteId} ===`,
    `Tasks: ${scorecard.taskCount} · Results: ${scorecard.resultCount} · Trials/task: ${scorecard.trialsPerTask}`,
    "",
  ];
  for (const axis of AXES) {
    const score = scorecard.axes[axis];
    lines.push(
      `${axis.padEnd(12)} mean=${percent(score.mean)} pass=${percent(score.passRate)} ` +
        `95%=[${percent(score.passLower95)}, ${percent(score.passUpper95)}] n=${score.samples}`,
    );
  }
  lines.push(
    "",
    `Verified completion: ${percent(scorecard.verifiedCompletionRate)}`,
    `Usable terminal:    ${percent(scorecard.usableTerminalRate)}`,
    `Recovery success:   ${scorecard.recoverySuccessRate === null ? "n/a" : percent(scorecard.recoverySuccessRate)}`,
    `Silent failures:    ${percent(scorecard.silentFailureRate)}`,
    `State corruption:   ${percent(scorecard.stateCorruptionRate)}`,
    `Cost: $${scorecard.totalCostUsd.toFixed(4)} · Mean duration: ${Math.round(scorecard.meanDurationMs)}ms`,
  );
  return lines.join("\n") + "\n";
}
