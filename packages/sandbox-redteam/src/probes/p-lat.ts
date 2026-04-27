// P-LAT-{boot,reset,roundtrip}
// Latency-distribution probes. Not adversarial — these measure the
// sandbox boundary's performance characteristics so the integrity
// monitor's overhead is observable.
//
// Mechanics:
//   - P-LAT-boot:      N iterations of shutdown() + boot()
//   - P-LAT-reset:     N iterations of executeTool(noop) + reset()
//   - P-LAT-roundtrip: N iterations of executeTool(noop) only
//
// Default N = 1000 per the spec, but overridable for fast unit tests
// (the test suite uses N = 50 to keep CI under a second).
//
// Honesty: validated against mock only. The numbers from the mock are
// effectively measuring Node event-loop overhead, not real sandbox
// performance. Real CHV/VF runs are required to derive operational
// p99 budgets.

import type { Sandbox } from "@brainst0rm/sandbox";

import { aggregate } from "../latency.js";
import type {
  AttackerClass,
  LatencyDistribution,
  Probe,
  ProbeOutcome,
} from "../types.js";

export interface LatencyProbeOptions {
  /** Iteration count. Defaults to 1000. */
  iterations?: number;
}

export function makeLatencyProbe(
  variant: "boot" | "reset" | "roundtrip",
  opts: LatencyProbeOptions = {},
): Probe {
  const N = opts.iterations ?? 1000;
  return {
    name: `P-LAT-${variant}`,
    attackerClass: "LAT" as AttackerClass,
    expectation: "should-pass",
    validatedAgainst: "mock-only",
    description:
      `${N}-iteration latency distribution for sandbox.${variant}(). ` +
      `Produces p50/p90/p95/p99. Mock-only on this checkout — the numbers ` +
      `reflect Node event-loop overhead, not real microVM timing.`,
    async run(sandbox: Sandbox): Promise<ProbeOutcome> {
      const samples = await sample(sandbox, variant, N);
      const dist = aggregate(samples);
      return {
        passed: true,
        reason: `collected ${dist.samples} samples`,
        evidence: { distribution: dist },
      };
    },
  };
}

async function sample(
  sandbox: Sandbox,
  variant: "boot" | "reset" | "roundtrip",
  N: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const t0 = nowNs();
    if (variant === "boot") {
      await sandbox.shutdown();
      await sandbox.boot();
    } else if (variant === "reset") {
      await sandbox.executeTool({
        command_id: `lat-reset-${i}`,
        tool: "noop",
        params: {},
        deadline_ms: 1_000,
      });
      await sandbox.reset();
    } else {
      await sandbox.executeTool({
        command_id: `lat-rt-${i}`,
        tool: "noop",
        params: {},
        deadline_ms: 1_000,
      });
    }
    const dt = nowNs() - t0;
    samples.push(Number(dt) / 1_000_000); // ns -> ms
  }
  return samples;
}

function nowNs(): bigint {
  return process.hrtime.bigint();
}

/** Convenience: build all three latency probes with a shared iteration count. */
export function makeLatencyBattery(opts: LatencyProbeOptions = {}): Probe[] {
  return [
    makeLatencyProbe("boot", opts),
    makeLatencyProbe("reset", opts),
    makeLatencyProbe("roundtrip", opts),
  ];
}

/** Re-export for callers that want to handle distributions directly. */
export type { LatencyDistribution };
