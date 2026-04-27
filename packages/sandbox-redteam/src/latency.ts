// Latency aggregation helpers for the LAT probe set.
//
// We compute p50/p90/p95/p99 by sorting the sample array and indexing.
// For 1000 samples this is fine. For >100k samples we'd want a better
// algorithm (e.g. t-digest); not needed at MVP.

import type { LatencyDistribution } from "./types.js";

/** Compute a percentile from a sorted ascending array of numbers. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (p <= 0) return sortedAsc[0]!;
  if (p >= 100) return sortedAsc[sortedAsc.length - 1]!;
  // Nearest-rank method (R-1): index = ceil(p/100 * N) - 1, clamped.
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx]!;
}

export function aggregate(samplesMs: number[]): LatencyDistribution {
  if (samplesMs.length === 0) {
    return {
      samples: 0,
      p50_ms: 0,
      p90_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      mean_ms: 0,
      min_ms: 0,
      max_ms: 0,
    };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    samples: sorted.length,
    p50_ms: percentile(sorted, 50),
    p90_ms: percentile(sorted, 90),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    mean_ms: sum / sorted.length,
    min_ms: sorted[0]!,
    max_ms: sorted[sorted.length - 1]!,
  };
}
