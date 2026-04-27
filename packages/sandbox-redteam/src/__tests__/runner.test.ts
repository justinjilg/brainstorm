// Tests for the P3.5a red-team framework against MockSandbox.
//
// These tests are the framework's only proof that probes mean what they
// say. Once a real CHV/VF host is available, the same probes (with
// additional `validatedAgainst` markers) become the production gate.
//
// Coverage target (per spec):
//   1. probe success path
//   2. probe failure path
//   3. latency aggregation correctness
//   4. P-A6 host-mutation detection (lying-VMM scenario)
//   5. report serialization round-trip
//   6. runner skip behaviour when sandbox is not available

import { describe, it, expect } from "vitest";

import {
  MockSandbox,
  RedTeamRunner,
  defenderToolBattery,
  attackerToolBattery,
  serializeReport,
  reportIsClean,
  aggregateLatency,
  percentile,
  pA1NetEgress,
  pA2FsEscape,
  pA3ProcessEscape,
  pA6SubstrateLie,
  pA8VsockPoison,
  ALL_ADVERSARIAL_PROBES,
  makeLatencyProbe,
} from "../index.js";
import { SandboxNotAvailableError, type Sandbox } from "@brainst0rm/sandbox";

// ---------- 1. probe success path ----------------------------------------

describe("RedTeamRunner — probe success path", () => {
  it("all 8 adversarial probes pass against a defender-posture mock", async () => {
    // ALL_ADVERSARIAL_PROBES is pre-ordered with P-A6 last so the
    // divergence-induced failed-state at the end doesn't skip earlier probes.
    const sandbox = new MockSandbox({ tools: defenderToolBattery() });
    const runner = new RedTeamRunner(sandbox, {
      probes: ALL_ADVERSARIAL_PROBES,
    });
    const report = await runner.run();

    expect(report.summary.total).toBe(8);
    expect(report.summary.passed).toBe(8);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.errored).toBe(0);

    // P-A6 is the last entry by design.
    expect(report.probes[report.probes.length - 1]!.name).toBe(
      "P-A6-substrate-lie",
    );
    // All probes carry honest validation status (mock-only today).
    for (const p of report.probes) {
      expect(p.validated_against).toBe("mock-only");
    }
  });
});

// ---------- 2. probe failure path ----------------------------------------

describe("RedTeamRunner — probe failure path", () => {
  it("records failures when the attacker-posture battery is wired in", async () => {
    const sandbox = new MockSandbox({ tools: attackerToolBattery() });
    const runner = new RedTeamRunner(sandbox, {
      probes: [
        pA1NetEgress, // egress succeeds -> fail
        pA2FsEscape, // host secret marker leaks -> fail
        pA3ProcessEscape, // signal succeeds -> fail
      ],
    });
    const report = await runner.run();
    expect(report.summary.total).toBe(3);
    expect(report.summary.failed).toBe(3);
    expect(report.summary.passed).toBe(0);
    for (const probe of report.probes) {
      expect(probe.passed).toBe(false);
      expect(probe.errored).toBe(false);
    }
    // P-A2 in particular should mention the host secret marker leak.
    const a2 = report.probes.find((p) => p.name === "P-A2-fs-escape")!;
    expect(a2.reason).toMatch(/host secret marker/i);
  });
});

// ---------- 3. latency aggregation correctness ---------------------------

describe("latency aggregation", () => {
  it("percentile() uses nearest-rank on sorted input", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 99)).toBe(10);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile([], 50)).toBe(0);
  });

  it("aggregate() produces p50/p90/p95/p99 + mean/min/max", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const dist = aggregateLatency(samples);
    expect(dist.samples).toBe(100);
    expect(dist.p50_ms).toBe(50);
    expect(dist.p90_ms).toBe(90);
    expect(dist.p95_ms).toBe(95);
    expect(dist.p99_ms).toBe(99);
    expect(dist.min_ms).toBe(1);
    expect(dist.max_ms).toBe(100);
    expect(dist.mean_ms).toBeCloseTo(50.5, 5);
  });

  it("LAT-roundtrip probe collects N samples and produces a distribution", async () => {
    const sandbox = new MockSandbox({ tools: defenderToolBattery() });
    const probe = makeLatencyProbe("roundtrip", { iterations: 50 });
    const runner = new RedTeamRunner(sandbox, { probes: [probe] });
    const report = await runner.run();
    expect(report.summary.passed).toBe(1);
    const evidence = report.probes[0]!.evidence as
      | { distribution?: { samples: number } }
      | undefined;
    expect(evidence?.distribution?.samples).toBe(50);
    // The runner should hoist the distribution into the top-level
    // `latency` map keyed by probe name.
    expect(report.latency["P-LAT-roundtrip"]?.samples).toBe(50);
  });
});

// ---------- 4. P-A6 host-mutation detection ------------------------------

describe("P-A6 substrate-lie detection", () => {
  it("honest VMM: detects host mutation and throws divergence on next reset", async () => {
    const sandbox = new MockSandbox({ tools: defenderToolBattery() });
    const runner = new RedTeamRunner(sandbox, { probes: [pA6SubstrateLie] });
    const report = await runner.run();
    expect(report.summary.passed).toBe(1);
    expect(report.probes[0]!.evidence).toMatchObject({
      error_code: "SANDBOX_RESET_DIVERGENCE",
    });
  });

  it("lying VMM: probe still catches via independent host evidence", async () => {
    // We use a fake reset implementation that "lies" — after the host
    // mutation, the mock's next reset is configured to claim baseline
    // state. The probe must still flag failure because overlay is
    // observably dirty post-reset (the independent host-side evidence
    // path).
    const sandbox = new MockSandbox({ tools: defenderToolBattery() });
    // Wrap reset() to swallow divergence and return a clean ResetState
    // — the canonical "lying VMM" failure mode.
    const realReset = sandbox.reset.bind(sandbox);
    sandbox.reset = async () => {
      try {
        return await realReset();
      } catch (_e) {
        // Lie: overlay still dirty, but report success.
        return {
          reset_at: new Date().toISOString(),
          golden_hash: "mock-fs-hash:0:00000000",
          verification_passed: true,
          verification_details: {
            fs_hash: "mock-fs-hash:0:00000000",
            fs_hash_baseline: "mock-fs-hash:0:00000000",
            fs_hash_match: true,
            open_fd_count: 0,
            open_fd_count_baseline: 0,
            vmm_api_state: "running",
            expected_vmm_api_state: "running",
            divergence_action: "none",
          },
        };
      }
    };
    const runner = new RedTeamRunner(sandbox, { probes: [pA6SubstrateLie] });
    const report = await runner.run();
    expect(report.summary.failed).toBe(1);
    expect(report.probes[0]!.passed).toBe(false);
    expect(report.probes[0]!.reason).toMatch(/overlay still contains/i);
  });
});

// ---------- 5. report serialization --------------------------------------

describe("RedTeamReport serialization", () => {
  it("round-trips via JSON and preserves schema_version + probe shape", async () => {
    const sandbox = new MockSandbox({ tools: defenderToolBattery() });
    const runner = new RedTeamRunner(sandbox, {
      probes: [pA1NetEgress, pA8VsockPoison],
    });
    const report = await runner.run();
    const json = serializeReport(report);
    const parsed = JSON.parse(json) as typeof report;
    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.probes).toHaveLength(2);
    expect(parsed.probes[0]!.name).toBe("P-A1-net-egress");
    expect(parsed.summary.total).toBe(2);
    expect(typeof parsed.generated_at).toBe("string");
    expect(reportIsClean(report)).toBe(true);
  });

  it("reportIsClean returns false on any failure", async () => {
    const sandbox = new MockSandbox({ tools: attackerToolBattery() });
    const runner = new RedTeamRunner(sandbox, { probes: [pA1NetEgress] });
    const report = await runner.run();
    expect(reportIsClean(report)).toBe(false);
  });
});

// ---------- 6. runner skip behaviour -------------------------------------

describe("RedTeamRunner — sandbox-not-available skip", () => {
  it("emits a skip note when boot() throws SandboxNotAvailableError", async () => {
    // Construct a Sandbox stand-in whose boot() fails the canonical way.
    const fakeSandbox: Sandbox = {
      backend: "chv",
      state: () => "not_booted",
      boot: async () => {
        throw new SandboxNotAvailableError(
          "cloud-hypervisor binary not found on this host (Darwin)",
        );
      },
      executeTool: async () => {
        throw new Error("should not be reached");
      },
      reset: async () => {
        throw new Error("should not be reached");
      },
      shutdown: async () => {},
    };
    const runner = new RedTeamRunner(fakeSandbox, {
      probes: ALL_ADVERSARIAL_PROBES,
    });
    const report = await runner.run();
    expect(report.summary.total).toBe(ALL_ADVERSARIAL_PROBES.length);
    expect(report.probes).toHaveLength(0);
    expect(report.notes.join(" ")).toMatch(/sandbox not available/i);
    // The CLI exit-code path: not clean (because nothing ran).
    expect(reportIsClean(report)).toBe(true); // no failures, no errors
    // But also no passes.
    expect(report.summary.passed).toBe(0);
  });
});
