// Core types for the P3.5a red-team test framework.
//
// A Probe is a single attacker-emulating test case targeted at one of the
// A1..A10 threat-model classes (docs/endpoint-agent-threat-model.md §3.1).
// A Probe runs against any concrete `Sandbox` implementation (CHV on Linux,
// VF on macOS, or a mock for unit tests).
//
// Every probe declares an `expectation`:
//   - "should-fail" — the attack MUST be contained by the sandbox. The
//     probe passes iff the sandbox blocked / rejected / killed / detected
//     the attack. The vast majority of probes are should-fail.
//   - "should-pass" — sanity-check probes (e.g. a benign tool call still
//     succeeds; a normal reset returns divergence_action="none"). Used to
//     prove the framework itself isn't producing false-positives.
//
// Honesty: a probe MUST self-report whether its `description` has been
// validated against a real (CHV or VF) sandbox or only against the mock.
// This becomes the `validated_against` field in the report.

import type { Sandbox } from "@brainst0rm/sandbox";

/** Attacker class identifiers per threat-model §3.1. */
export type AttackerClass =
  | "A1" // outsider w/ relay creds
  | "A2" // outsider w/o creds (network)
  | "A3" // compromised tool inside sandbox
  | "A4" // compromised image (build-time)
  | "A5" // compromised host agent
  | "A6" // substrate-lying attacker (the headline case)
  | "A7" // participant-orchestrator contamination
  | "A8" // cross-endpoint replay
  | "A9" // cross-context replay
  | "A10" // replay after agent restart
  | "LAT" // synthetic class for latency-distribution probes
  | "sandbox-runtime-limit"; // synthetic class — sandbox-runtime resource/deadline
  // limits, NOT one of the formal A1..A10 attacker classes. Used by probes that
  // exercise host-side enforcement (cgroup OOM kill, deadline_ms cancellation)
  // rather than emulating an actual attacker. See p-a4-resource-exhaust.ts and
  // p-a5-time-bomb.ts for the rationale (the names are kept for filename
  // continuity but the tagging is honest about scope).

export type ProbeExpectation = "should-pass" | "should-fail";

/** Where a probe has been exercised against real machinery. */
export type ValidationStatus =
  | "mock-only"
  | "validated-chv"
  | "validated-vf"
  | "validated-chv-and-vf";

export interface Probe {
  /** Stable id, e.g. "P-A6-substrate-lie". */
  readonly name: string;
  /** Attacker class this probe emulates. */
  readonly attackerClass: AttackerClass;
  /** Free-form human description (1-2 sentences). */
  readonly description: string;
  /** Honesty marker: validated against real sandbox or mock-only. */
  readonly validatedAgainst: ValidationStatus;
  /** Expected outcome relative to the sandbox boundary. */
  readonly expectation: ProbeExpectation;
  /**
   * Optional: probes that mutate sandbox state (e.g. P-A6 host-mutation)
   * may need a hook to run BEFORE `executeTool` is called. Defaults to
   * a no-op.
   */
  setup?(sandbox: Sandbox): Promise<void>;
  /** Run the probe and return a result. */
  run(sandbox: Sandbox): Promise<ProbeOutcome>;
  /** Optional teardown after run. */
  teardown?(sandbox: Sandbox): Promise<void>;
}

/**
 * Outcome a probe reports back. The runner converts this into a
 * `ProbeResult` with timing/wrapping metadata.
 */
export interface ProbeOutcome {
  /**
   * `true` if the probe achieved its expected outcome:
   *   - for `should-fail`, attack was contained
   *   - for `should-pass`, benign behaviour observed
   * `false` means the attack succeeded OR the benign path failed — both
   * are red-team failures, the report distinguishes them.
   */
  passed: boolean;
  /** Short human reason — surfaces in the report. */
  reason: string;
  /**
   * Optional structured evidence the probe wants persisted into the
   * report (e.g. captured stdout, vmm_api_state, latency samples).
   */
  evidence?: Record<string, unknown>;
}

/** A single probe's run result, after the runner adds timing. */
export interface ProbeResult {
  name: string;
  attacker_class: AttackerClass;
  expectation: ProbeExpectation;
  validated_against: ValidationStatus;
  description: string;
  passed: boolean;
  reason: string;
  duration_ms: number;
  /** True iff the probe threw an unexpected error (framework-level fault). */
  errored: boolean;
  /** Stringified error if `errored`. */
  error_message?: string;
  evidence?: Record<string, unknown>;
}

/** Aggregate latency stats for the LAT probe set. */
export interface LatencyDistribution {
  samples: number;
  p50_ms: number;
  p90_ms: number;
  p95_ms: number;
  p99_ms: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
}

export interface RedTeamReport {
  /** Schema version of this report shape. */
  schema_version: "1.0";
  generated_at: string;
  /** Sandbox backend label ("chv", "vf", "stub", "mock"). */
  backend: string;
  /** Sandbox state at end of run. */
  final_sandbox_state: string;
  /** Per-probe results. */
  probes: ProbeResult[];
  /** Latency distributions for any LAT probes that ran. */
  latency: Record<string, LatencyDistribution>;
  /** Aggregate counts. */
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    skipped: number;
  };
  /** Free-form notes (e.g. "skipped P-A6 because real reset unavailable"). */
  notes: string[];
}

/** Configuration knobs for `RedTeamRunner`. */
export interface RedTeamRunnerOptions {
  /** Probes to run. If omitted, runner defaults to the full battery. */
  probes?: Probe[];
  /**
   * If true, the runner attempts `sandbox.boot()` itself. If false, the
   * caller must boot the sandbox before passing it in. Default: true.
   */
  autoBoot?: boolean;
  /**
   * If true, the runner calls `sandbox.shutdown()` after the battery.
   * Default: true.
   */
  autoShutdown?: boolean;
  /**
   * Per-probe wall-clock budget. If a probe exceeds this, the runner
   * marks it as errored (framework-level fault, not a red-team failure).
   * Default: 30_000 ms.
   */
  perProbeTimeoutMs?: number;
  /**
   * Optional logger. Defaults to no-op.
   */
  logger?: { info(msg: string): void; error(msg: string): void };
}
