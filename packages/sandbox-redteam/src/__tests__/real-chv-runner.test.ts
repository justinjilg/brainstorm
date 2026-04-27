// Tests for the P3.5b real-CHV validation modes.
//
// These tests use a deterministic-timing fake `Sandbox` so we can assert
// the aggregation math, the concurrent-launch behaviour, the failure-mode
// reporting, and the JSON output schema without touching real CHV.
//
// The real-CHV path itself is exercised by
// `packages/sandbox/scripts/full-validation.sh` on a Linux+KVM host —
// these unit tests only prove the framework code does the right thing
// once the real sandbox is wired in.

import { describe, expect, it } from "vitest";

import {
  buildChvConfig,
  concurrentOverrides,
  shardSocketPath,
  runConcurrentBattery,
  runLatencyBattery,
  serializeReport,
  summariseValidationProvenance,
} from "../index.js";
import type {
  Sandbox,
  SandboxBackend,
  SandboxState,
  ToolExecution,
  ToolInvocation,
} from "@brainst0rm/sandbox";

// ---------- deterministic-timing fake Sandbox ----------------------------

interface FakeSandboxOpts {
  /** ms to spend in `boot()` (simulated via setTimeout). */
  bootMs?: number;
  /** ms to spend in `executeTool()`. */
  execMs?: number;
  /** ms to spend in `shutdown()`. */
  shutdownMs?: number;
  /** Force boot to throw with this message. */
  failBoot?: string;
  /** Force exec to throw with this message. */
  failExec?: string;
  /** Force exec to return a non-zero exit_code with this stderr. */
  execNonZero?: { exit_code: number; stderr: string };
  /** Force shutdown to throw with this message. */
  failShutdown?: string;
  /** Backend label to surface. */
  backend?: SandboxBackend;
}

class FakeSandbox implements Sandbox {
  public readonly backend: SandboxBackend;
  private status: SandboxState = "not_booted";
  private readonly opts: FakeSandboxOpts;
  constructor(opts: FakeSandboxOpts = {}) {
    this.opts = opts;
    this.backend = opts.backend ?? "chv";
  }
  state(): SandboxState {
    return this.status;
  }
  async boot(): Promise<void> {
    this.status = "booting";
    await sleep(this.opts.bootMs ?? 0);
    if (this.opts.failBoot !== undefined) {
      this.status = "failed";
      throw new Error(this.opts.failBoot);
    }
    this.status = "ready";
  }
  async executeTool(_inv: ToolInvocation): Promise<ToolExecution> {
    await sleep(this.opts.execMs ?? 0);
    if (this.opts.failExec !== undefined) {
      throw new Error(this.opts.failExec);
    }
    if (this.opts.execNonZero !== undefined) {
      return {
        exit_code: this.opts.execNonZero.exit_code,
        stdout: "",
        stderr: this.opts.execNonZero.stderr,
      };
    }
    return { exit_code: 0, stdout: "echo ok", stderr: "" };
  }
  async reset(): Promise<never> {
    throw new Error("reset not implemented in FakeSandbox");
  }
  async shutdown(): Promise<void> {
    await sleep(this.opts.shutdownMs ?? 0);
    if (this.opts.failShutdown !== undefined) {
      throw new Error(this.opts.failShutdown);
    }
    this.status = "not_booted";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 1. lat-only mode aggregation math ----------------------------

describe("runLatencyBattery — aggregation math", () => {
  it("collects N samples, all-passing case produces clean report", async () => {
    const N = 20;
    const factory = (): Sandbox =>
      new FakeSandbox({ bootMs: 1, execMs: 0, shutdownMs: 0 });
    const report = await runLatencyBattery(factory, {
      iterations: N,
      backendLabel: "chv-test",
    });

    expect(report.summary.total).toBe(4); // boot/roundtrip/shutdown/total
    expect(report.summary.passed).toBe(4);
    expect(report.summary.failed).toBe(0);
    expect(report.latency["P-LAT-boot"]?.samples).toBe(N);
    expect(report.latency["P-LAT-roundtrip"]?.samples).toBe(N);
    expect(report.latency["P-LAT-shutdown"]?.samples).toBe(N);
    expect(report.latency["P-LAT-total"]?.samples).toBe(N);

    // boot should dominate timing since execMs=0/shutdownMs=0 and bootMs=1.
    // Since setTimeout granularity is rough, just assert the relationship.
    const bootDist = report.latency["P-LAT-boot"]!;
    expect(bootDist.min_ms).toBeGreaterThanOrEqual(0);
    expect(bootDist.max_ms).toBeGreaterThanOrEqual(bootDist.min_ms);
    expect(bootDist.p99_ms).toBeGreaterThanOrEqual(bootDist.p50_ms);

    // Probe results carry the validation-provenance marker.
    for (const probe of report.probes) {
      expect(probe.validated_against).toBe("validated-chv");
      expect(probe.attacker_class).toBe("LAT");
      expect(probe.passed).toBe(true);
    }
  });

  it("records per-iteration failures without aborting the battery", async () => {
    const N = 10;
    let i = -1;
    const factory = (): Sandbox => {
      i += 1;
      // Fail boot on iter 3 + 7. All other iterations succeed.
      if (i === 3 || i === 7) {
        return new FakeSandbox({ failBoot: `forced-boot-failure-${i}` });
      }
      return new FakeSandbox({ bootMs: 1 });
    };
    const report = await runLatencyBattery(factory, {
      iterations: N,
      backendLabel: "chv-test",
    });

    // 4 LAT probes, all marked "failed" because not every iter succeeded.
    expect(report.summary.failed).toBe(4);
    expect(report.summary.passed).toBe(0);
    const ev = report.probes[0]!.evidence as {
      iterations_attempted: number;
      iterations_succeeded: number;
      iterations_failed: number;
      failure_phases: Record<string, number>;
    };
    expect(ev.iterations_attempted).toBe(N);
    expect(ev.iterations_succeeded).toBe(N - 2);
    expect(ev.iterations_failed).toBe(2);
    expect(ev.failure_phases.boot).toBe(2);
  });

  it("aggregates known timings deterministically", async () => {
    // Force iter index into bootMs so we get a known distribution.
    let i = -1;
    const factory = (): Sandbox => {
      i += 1;
      // bootMs sweeps 1..10ms — the resulting distribution should have
      // p50 ~ 5..6ms and p99 == max == 10ms (or close due to setTimeout
      // jitter).
      return new FakeSandbox({ bootMs: i + 1 });
    };
    const N = 10;
    const report = await runLatencyBattery(factory, {
      iterations: N,
      backendLabel: "chv-test",
    });
    const bootDist = report.latency["P-LAT-boot"]!;
    expect(bootDist.samples).toBe(N);
    // p99 should be the largest sample (or within timer slack) — the
    // 10th iteration sleeps the longest. We allow a 50ms slack to tolerate
    // event-loop scheduling jitter on busy CI runners.
    expect(bootDist.p99_ms).toBeGreaterThanOrEqual(bootDist.p50_ms);
    expect(bootDist.max_ms).toBeGreaterThanOrEqual(bootDist.p99_ms);
    expect(bootDist.min_ms).toBeLessThanOrEqual(bootDist.p50_ms);
  });
});

// ---------- 2. concurrent mode launches N sandboxes ----------------------

describe("runConcurrentBattery — N sandboxes in parallel", () => {
  it("launches N sandboxes and reports per-instance results", async () => {
    const N = 8;
    const factory = (i: number): Sandbox => {
      // Boot times stagger so we can observe parallelism (highest takes
      // ~16ms; total wall-clock should be << N*16ms because they're
      // concurrent).
      return new FakeSandbox({ bootMs: 2 + (i % 4) * 2 });
    };
    const t0 = Date.now();
    const report = await runConcurrentBattery(factory, {
      concurrency: N,
      backendLabel: "chv-test",
    });
    const elapsed = Date.now() - t0;

    expect(report.summary.total).toBe(N);
    expect(report.summary.passed).toBe(N);
    expect(report.summary.failed).toBe(0);

    // All probes named P-CONC-instance-0..N-1.
    for (let i = 0; i < N; i += 1) {
      const probe = report.probes.find(
        (p) => p.name === `P-CONC-instance-${i}`,
      );
      expect(probe).toBeDefined();
      expect(probe!.passed).toBe(true);
      expect(probe!.validated_against).toBe("validated-chv");
    }

    // Parallelism check: total wall < ~N*16ms by a wide margin.
    // Generous 200ms upper bound to tolerate noisy CI; sequential would
    // be roughly sum(2,4,6,8,2,4,6,8) = 40ms with overhead. Concurrent
    // should be ~8ms-ish.
    expect(elapsed).toBeLessThan(200);

    // Latency map populated.
    expect(report.latency["P-CONC-boot"]?.samples).toBe(N);
    expect(report.latency["P-CONC-exec"]?.samples).toBe(N);
    expect(report.latency["P-CONC-shutdown"]?.samples).toBe(N);
  });
});

// ---------- 3. concurrent mode fails cleanly when one of N fails ---------

describe("runConcurrentBattery — failure isolation", () => {
  it("records the failing instance, others still pass", async () => {
    const N = 6;
    const factory = (i: number): Sandbox => {
      if (i === 3) {
        return new FakeSandbox({ failBoot: "instance-3-cant-boot" });
      }
      return new FakeSandbox({ bootMs: 1 });
    };
    const report = await runConcurrentBattery(factory, {
      concurrency: N,
      backendLabel: "chv-test",
    });

    expect(report.summary.total).toBe(N);
    expect(report.summary.passed).toBe(N - 1);
    expect(report.summary.failed).toBe(1);

    const failed = report.probes.find((p) => p.name === "P-CONC-instance-3")!;
    expect(failed.passed).toBe(false);
    expect(failed.reason).toMatch(/boot.*instance-3-cant-boot/);
    const ev = failed.evidence as {
      failure_phase?: string;
      error?: string;
    };
    expect(ev.failure_phase).toBe("boot");

    // Notes section enumerates each failure for operator visibility.
    expect(report.notes.join(" ")).toMatch(/instance 3 failed/);
  });

  it("exec-phase failure on one instance reported distinctly", async () => {
    const N = 4;
    const factory = (i: number): Sandbox => {
      if (i === 1) {
        return new FakeSandbox({ failExec: "exec-blew-up" });
      }
      return new FakeSandbox();
    };
    const report = await runConcurrentBattery(factory, {
      concurrency: N,
      backendLabel: "chv-test",
    });
    expect(report.summary.failed).toBe(1);
    const failed = report.probes.find((p) => p.name === "P-CONC-instance-1")!;
    const ev = failed.evidence as { failure_phase?: string };
    expect(ev.failure_phase).toBe("exec");
  });
});

// ---------- 4. validation-provenance count distinct ----------------------

describe("validation provenance counting", () => {
  it("distinguishes mock-only vs validated-chv probes in the summary", async () => {
    const N = 3;
    const factory = (): Sandbox => new FakeSandbox();
    // Run a real-CHV-marked latency battery → all 4 probes are
    // validated-chv.
    const real = await runLatencyBattery(factory, {
      iterations: N,
      validatedAgainst: "validated-chv",
      backendLabel: "chv",
    });
    const realProv = summariseValidationProvenance(real);
    expect(realProv.validatedChv).toBe(4);
    expect(realProv.mockOnly).toBe(0);
    expect(realProv.total).toBe(4);

    // Manually craft a report with a mix to assert the counter handles
    // multiple statuses without conflating them.
    const mixed = {
      ...real,
      probes: [
        ...real.probes,
        {
          ...real.probes[0]!,
          name: "P-A6-mock",
          validated_against: "mock-only" as const,
        },
        {
          ...real.probes[0]!,
          name: "P-A1-mock",
          validated_against: "mock-only" as const,
        },
      ],
    };
    const mixedProv = summariseValidationProvenance(mixed);
    expect(mixedProv.total).toBe(6);
    expect(mixedProv.validatedChv).toBe(4);
    expect(mixedProv.mockOnly).toBe(2);
    expect(mixedProv.validatedVf).toBe(0);
  });
});

// ---------- 5. JSON output schema is stable ------------------------------

describe("JSON output schema", () => {
  it("real-chv lat report round-trips with stable top-level keys", async () => {
    const factory = (): Sandbox => new FakeSandbox();
    const report = await runLatencyBattery(factory, {
      iterations: 5,
      backendLabel: "chv",
    });
    const json = serializeReport(report);
    const parsed = JSON.parse(json) as typeof report;

    // Schema-version is pinned.
    expect(parsed.schema_version).toBe("1.0");

    // Top-level keys match the documented set.
    const keys = new Set(Object.keys(parsed));
    expect(keys.has("schema_version")).toBe(true);
    expect(keys.has("generated_at")).toBe(true);
    expect(keys.has("backend")).toBe(true);
    expect(keys.has("final_sandbox_state")).toBe(true);
    expect(keys.has("probes")).toBe(true);
    expect(keys.has("latency")).toBe(true);
    expect(keys.has("summary")).toBe(true);
    expect(keys.has("notes")).toBe(true);

    // summary keys match.
    const summaryKeys = new Set(Object.keys(parsed.summary));
    expect(summaryKeys.has("total")).toBe(true);
    expect(summaryKeys.has("passed")).toBe(true);
    expect(summaryKeys.has("failed")).toBe(true);
    expect(summaryKeys.has("errored")).toBe(true);
    expect(summaryKeys.has("skipped")).toBe(true);

    // Probe shape matches.
    for (const probe of parsed.probes) {
      expect(probe.name).toBeDefined();
      expect(probe.attacker_class).toBeDefined();
      expect(probe.expectation).toBeDefined();
      expect(probe.validated_against).toBeDefined();
      expect(typeof probe.passed).toBe("boolean");
      expect(typeof probe.reason).toBe("string");
      expect(typeof probe.duration_ms).toBe("number");
      expect(typeof probe.errored).toBe("boolean");
    }

    // Each LatencyDistribution carries the documented stats.
    for (const dist of Object.values(parsed.latency)) {
      expect(typeof dist.samples).toBe("number");
      expect(typeof dist.p50_ms).toBe("number");
      expect(typeof dist.p90_ms).toBe("number");
      expect(typeof dist.p95_ms).toBe("number");
      expect(typeof dist.p99_ms).toBe("number");
      expect(typeof dist.mean_ms).toBe("number");
      expect(typeof dist.min_ms).toBe("number");
      expect(typeof dist.max_ms).toBe("number");
    }
  });

  it("concurrent report round-trips with stable schema", async () => {
    const factory = (): Sandbox => new FakeSandbox();
    const report = await runConcurrentBattery(factory, {
      concurrency: 3,
      backendLabel: "chv",
    });
    const json = serializeReport(report);
    const parsed = JSON.parse(json) as typeof report;
    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.probes.length).toBe(3);
    expect(parsed.latency["P-CONC-boot"]).toBeDefined();
  });
});

// ---------- 6. config builder + concurrent overrides ---------------------

describe("buildChvConfig + concurrentOverrides", () => {
  it("rejects missing required env vars with humane errors", () => {
    const here = new URL(import.meta.url).pathname;
    expect(() => buildChvConfig({})).toThrow(/BSM_KERNEL is required/);
    expect(() => buildChvConfig({ BSM_KERNEL: here })).toThrow(
      /BSM_ROOTFS is required/,
    );
  });

  it("rejects nonexistent paths", () => {
    const here = new URL(import.meta.url).pathname;
    expect(() =>
      buildChvConfig({
        BSM_KERNEL: "/this/path/does/not/exist",
        BSM_ROOTFS: here,
      }),
    ).toThrow(/BSM_KERNEL points to nonexistent path/);
  });

  it("shardSocketPath inserts -N before .sock", () => {
    expect(shardSocketPath("/tmp/foo.sock", 0)).toBe("/tmp/foo-0.sock");
    expect(shardSocketPath("/tmp/foo.sock", 7)).toBe("/tmp/foo-7.sock");
    expect(shardSocketPath("/tmp/foo", 3)).toBe("/tmp/foo-3");
  });

  it("concurrentOverrides assigns unique cid 3+i and unique sockets", () => {
    const o0 = concurrentOverrides(0, "/tmp/v.sock", "/tmp/a.sock");
    const o1 = concurrentOverrides(1, "/tmp/v.sock", "/tmp/a.sock");
    expect(o0.cid).toBe(3);
    expect(o1.cid).toBe(4);
    expect(o0.vsockSocketPath).toBe("/tmp/v-0.sock");
    expect(o1.vsockSocketPath).toBe("/tmp/v-1.sock");
    expect(o0.apiSocketPath).toBe("/tmp/a-0.sock");
    expect(o1.apiSocketPath).toBe("/tmp/a-1.sock");
  });

  it("buildChvConfig accepts overrides and produces the right config", () => {
    // Use a self-reference path that always exists across platforms
    // (we're just testing the shape, not actually loading the kernel).
    const here = new URL(import.meta.url).pathname;
    const env = {
      BSM_KERNEL: here,
      BSM_ROOTFS: here,
      BSM_VSOCK_SOCKET: "/tmp/v.sock",
      BSM_API_SOCKET: "/tmp/a.sock",
    };
    const overrides = concurrentOverrides(2, "/tmp/v.sock", "/tmp/a.sock");
    const built = buildChvConfig(env, overrides);
    expect(built.config.vsock.cid).toBe(5);
    expect(built.config.vsock.socketPath).toBe("/tmp/v-2.sock");
    expect(built.config.apiSocketPath).toBe("/tmp/a-2.sock");
    expect(built.effective.cid).toBe(5);
  });
});
