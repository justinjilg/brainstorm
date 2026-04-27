// RedTeamRunner — orchestrates a battery of probes against a single
// Sandbox instance and produces a structured RedTeamReport.
//
// Lifecycle:
//   1. (optional) sandbox.boot()
//   2. for each probe:
//        a. probe.setup(sandbox)         (best-effort; failures => errored)
//        b. probe.run(sandbox)           (timed; per-probe budget)
//        c. probe.teardown(sandbox)
//        d. sandbox.reset()              (after every probe — D13 trigger)
//   3. (optional) sandbox.shutdown()
//
// The runner is intentionally tolerant of probe-level failures so that
// one broken probe does not abort the rest of the battery. Framework
// errors (timeouts, thrown exceptions outside the probe contract) are
// recorded as `errored: true` and distinguished in the report from
// red-team failures.
//
// Per-attack containment failures are NOT thrown — they're recorded
// faithfully so the report can show the full picture.

import {
  SandboxNotAvailableError,
  SandboxResetDivergenceError,
} from "@brainst0rm/sandbox";
import type { Sandbox } from "@brainst0rm/sandbox";

import { aggregate } from "./latency.js";
import type {
  LatencyDistribution,
  Probe,
  ProbeOutcome,
  ProbeResult,
  RedTeamReport,
  RedTeamRunnerOptions,
} from "./types.js";

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const NOOP_LOGGER = {
  info: (_m: string) => {},
  error: (_m: string) => {},
};

export class RedTeamRunner {
  private readonly sandbox: Sandbox;
  private readonly opts: Required<
    Omit<RedTeamRunnerOptions, "logger" | "probes">
  > & {
    logger: NonNullable<RedTeamRunnerOptions["logger"]>;
    probes: Probe[];
  };
  private readonly notes: string[] = [];
  private readonly latency: Record<string, LatencyDistribution> = {};

  constructor(sandbox: Sandbox, options: RedTeamRunnerOptions = {}) {
    this.sandbox = sandbox;
    this.opts = {
      probes: options.probes ?? [],
      autoBoot: options.autoBoot ?? true,
      autoShutdown: options.autoShutdown ?? true,
      perProbeTimeoutMs: options.perProbeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      logger: options.logger ?? NOOP_LOGGER,
    };
  }

  /** Record a latency distribution (called by probes via the helper). */
  recordLatency(name: string, samplesMs: number[]): void {
    this.latency[name] = aggregate(samplesMs);
  }

  async run(): Promise<RedTeamReport> {
    const results: ProbeResult[] = [];
    let skipped = 0;

    if (this.opts.autoBoot) {
      try {
        await this.sandbox.boot();
      } catch (e) {
        if (e instanceof SandboxNotAvailableError) {
          // Real CHV/VF host not available — emit a meaningful skip
          // report so callers can see WHY their battery didn't run.
          this.notes.push(
            `sandbox not available on this host: ${(e as Error).message}; ` +
              `all probes skipped. Re-run on a Linux host with cloud-hypervisor ` +
              `or a macOS host with the VF helper to exercise the real boundary.`,
          );
          return this.finalReport(results, this.opts.probes.length, 0);
        }
        this.notes.push(`boot failed: ${(e as Error).message}`);
        return this.finalReport(results, 0, 0);
      }
    }

    for (const probe of this.opts.probes) {
      this.opts.logger.info(
        `running probe ${probe.name} (${probe.attackerClass})`,
      );
      const result = await this.runOne(probe);
      results.push(result);

      // Promote any LAT-class distribution into the top-level `latency`
      // map so consumers don't have to dig through evidence. The probe
      // itself owns the aggregation; the runner just hoists.
      if (probe.attackerClass === "LAT" && result.evidence !== undefined) {
        const dist = (result.evidence as { distribution?: LatencyDistribution })
          .distribution;
        if (dist !== undefined) {
          this.latency[probe.name] = dist;
        }
      }

      // Per D13: reset after every dispatch. We do the same after every
      // probe so each probe sees a fresh sandbox. If a probe was DESIGNED
      // to drive a divergence (P-A6), the reset call ITSELF is the
      // assertion — it should throw SandboxResetDivergenceError.
      // We swallow that throw because the probe already recorded the
      // outcome, but we *do* note it.
      if (this.sandbox.state() === "ready") {
        try {
          await this.sandbox.reset();
        } catch (e) {
          if (e instanceof SandboxResetDivergenceError) {
            this.notes.push(
              `post-${probe.name} reset diverged (expected for A6-class ` +
                `probes): ${(e as Error).message}`,
            );
            // Sandbox is now `failed`. Subsequent probes will be skipped.
          } else {
            this.notes.push(
              `post-${probe.name} reset error: ${(e as Error).message}`,
            );
          }
        }
      }
      if (this.sandbox.state() === "failed") {
        this.notes.push(
          `sandbox failed after ${probe.name}; remaining probes skipped`,
        );
        skipped = this.opts.probes.length - results.length;
        break;
      }
    }

    if (this.opts.autoShutdown) {
      try {
        await this.sandbox.shutdown();
      } catch (e) {
        this.notes.push(`shutdown error: ${(e as Error).message}`);
      }
    }

    return this.finalReport(results, skipped, 0);
  }

  // ----- internals -------------------------------------------------------

  private async runOne(probe: Probe): Promise<ProbeResult> {
    const start = Date.now();
    let outcome: ProbeOutcome | null = null;
    let errored = false;
    let errorMessage: string | undefined;

    try {
      if (probe.setup !== undefined) {
        await probe.setup(this.sandbox);
      }
      outcome = await runWithBudget(
        probe.run(this.sandbox),
        this.opts.perProbeTimeoutMs,
      );
      if (probe.teardown !== undefined) {
        await probe.teardown(this.sandbox);
      }
    } catch (e) {
      errored = true;
      errorMessage = (e as Error).message;
      this.opts.logger.error(`probe ${probe.name} threw: ${errorMessage}`);
    }
    const duration_ms = Date.now() - start;

    return {
      name: probe.name,
      attacker_class: probe.attackerClass,
      expectation: probe.expectation,
      validated_against: probe.validatedAgainst,
      description: probe.description,
      passed: outcome?.passed ?? false,
      reason:
        outcome?.reason ??
        (errored ? `framework error: ${errorMessage}` : "no outcome reported"),
      duration_ms,
      errored,
      error_message: errorMessage,
      evidence: outcome?.evidence,
    };
  }

  private finalReport(
    results: ProbeResult[],
    skipped: number,
    _carry: number,
  ): RedTeamReport {
    const passed = results.filter((r) => r.passed && !r.errored).length;
    const errored = results.filter((r) => r.errored).length;
    const failed = results.length - passed - errored;
    return {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      backend: this.sandbox.backend,
      final_sandbox_state: this.sandbox.state(),
      probes: results,
      latency: this.latency,
      summary: {
        total: this.opts.probes.length,
        passed,
        failed,
        errored,
        skipped,
      },
      notes: this.notes,
    };
  }
}

/** Race a probe promise against a wall-clock budget. */
async function runWithBudget<T>(p: Promise<T>, budgetMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`probe exceeded budget_ms=${budgetMs}`));
    }, budgetMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
