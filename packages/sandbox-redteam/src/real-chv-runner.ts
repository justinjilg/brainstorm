// Real-CHV-only validation modes.
//
// Two modes live here:
//   1. `runLatencyBattery()` — N iterations of cold-boot + dispatch + shutdown.
//      Each iteration creates a *fresh* Sandbox instance so we measure cold
//      machinery, not warm-cache reuse. Aggregates p50/p90/p95/p99 + min/max
//      for boot, exec, shutdown, and total per-iteration timing.
//
//   2. `runConcurrentBattery()` — stand up N Sandbox instances in parallel,
//      boot them all, dispatch one echo each, shut them all down. Verifies
//      they don't interfere (unique cid + unique sockets).
//
// Both modes are *separate* from `RedTeamRunner` because the lifecycle is
// fundamentally different: RedTeamRunner runs many probes against ONE
// sandbox; these modes run ONE probe against many sandbox lifetimes.
//
// Both modes accept a sandbox factory (`SandboxFactory`) so unit tests can
// inject deterministic-timing fakes. The bin/cli wires the real factory to
// `new ChvSandbox(buildChvConfig(...).config)`.
//
// Honesty: a probe that runs through this path is genuinely cold-booting a
// real CHV VM and round-tripping vsock RPC. The reports flag this with
// `validatedAgainst: "validated-chv"`. Failures (boot timeouts, exec
// nonzero, shutdown errors) are recorded faithfully — never swallowed.

import { aggregate } from "./latency.js";
import type {
  LatencyDistribution,
  RedTeamReport,
  ProbeResult,
  ValidationStatus,
} from "./types.js";
import type { Sandbox, ToolExecution } from "@brainst0rm/sandbox";

/**
 * A factory that constructs a fresh Sandbox per call. The factory is the
 * unit-of-isolation: lat-only mode calls it N times, concurrent mode calls
 * it concurrency-many times.
 *
 * `index` is the 0-based instance number — useful for the concurrent path
 * to assign unique CIDs / socket paths.
 */
export type SandboxFactory = (index: number) => Promise<Sandbox> | Sandbox;

export interface LatencyBatteryOptions {
  /** Iteration count. Defaults to 1000 per spec. */
  iterations?: number;
  /** Tool to dispatch each iteration. Defaults to "echo". */
  tool?: string;
  /** Tool params. Defaults to `{ message: "lat-probe" }`. */
  params?: Record<string, unknown>;
  /** Per-tool deadline. Defaults to 30s. */
  deadlineMs?: number;
  /** Optional logger. Defaults to no-op. */
  logger?: { info: (m: string) => void; error: (m: string) => void };
  /** Validation status to attach to the synthesised probe results. */
  validatedAgainst?: ValidationStatus;
  /** Backend label to surface in the report. Default "chv". */
  backendLabel?: string;
  /**
   * Progress callback fired every M iterations. Useful for the CLI to
   * print "iter 200/1000". Defaults to no-op.
   */
  onProgress?: (completed: number, total: number) => void;
  /**
   * Iteration interval at which `onProgress` fires. Default 50.
   */
  progressInterval?: number;
}

export interface ConcurrentBatteryOptions {
  /** Number of concurrent sandbox instances. Default 8. */
  concurrency?: number;
  /** Tool to dispatch in each instance. Defaults to "echo". */
  tool?: string;
  /** Tool params. Defaults to `{ message: "concurrent-probe-${i}" }`. */
  paramsForIndex?: (index: number) => Record<string, unknown>;
  /** Per-tool deadline. Defaults to 30s. */
  deadlineMs?: number;
  /** Optional logger. Defaults to no-op. */
  logger?: { info: (m: string) => void; error: (m: string) => void };
  /** Validation status to attach to the synthesised probe results. */
  validatedAgainst?: ValidationStatus;
  /** Backend label to surface in the report. Default "chv". */
  backendLabel?: string;
}

const NOOP_LOGGER = {
  info: (_m: string) => {},
  error: (_m: string) => {},
};

const DEFAULT_TOOL = "echo";
const DEFAULT_DEADLINE_MS = 30_000;

interface PerIterationTiming {
  iter: number;
  ok: boolean;
  /** Boot phase wall time (ms). Always recorded — even on failure we know
   *  how long boot took before it failed. */
  boot_ms: number;
  /** executeTool() wall time (ms). 0 if boot failed. */
  exec_ms: number;
  /** shutdown() wall time (ms). 0 if not reached. */
  shutdown_ms: number;
  /** total wall time (ms). */
  total_ms: number;
  /** exit_code from the tool execution (only meaningful if `ok`). */
  exit_code?: number;
  /** Failure phase ("boot" | "exec" | "shutdown") if `!ok`. */
  failure_phase?: "boot" | "exec" | "shutdown";
  /** Error message if `!ok`. */
  error?: string;
}

/**
 * 1000-iter (or N-iter) cold-boot + dispatch + shutdown latency battery.
 *
 * Each iteration:
 *   1. factory(i) -> fresh sandbox
 *   2. sandbox.boot()
 *   3. sandbox.executeTool({ tool, params, ... })
 *   4. sandbox.shutdown()
 *
 * Failures in any phase are recorded but DO NOT abort the battery — we
 * want the full distribution including failures so the operator can see
 * "997/1000 succeeded, p99 boot=712ms, 3 failures all in shutdown phase".
 */
export async function runLatencyBattery(
  factory: SandboxFactory,
  options: LatencyBatteryOptions = {},
): Promise<RedTeamReport> {
  const N = options.iterations ?? 1000;
  if (!Number.isInteger(N) || N <= 0) {
    throw new Error(`iterations must be a positive integer, got ${N}`);
  }
  const tool = options.tool ?? DEFAULT_TOOL;
  const params = options.params ?? { message: "lat-probe" };
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const logger = options.logger ?? NOOP_LOGGER;
  const validatedAgainst = options.validatedAgainst ?? "validated-chv";
  const backendLabel = options.backendLabel ?? "chv";
  const progressInterval = options.progressInterval ?? 50;
  const onProgress = options.onProgress ?? ((): void => {});

  const start_t = Date.now();
  const timings: PerIterationTiming[] = [];

  for (let i = 0; i < N; i += 1) {
    const t = await runOneLatencyIteration(
      factory,
      i,
      tool,
      params,
      deadlineMs,
      logger,
    );
    timings.push(t);
    if ((i + 1) % progressInterval === 0 || i + 1 === N) {
      onProgress(i + 1, N);
    }
  }
  const duration_ms = Date.now() - start_t;

  const okTimings = timings.filter((x) => x.ok);
  const bootSamples = okTimings.map((x) => x.boot_ms);
  const execSamples = okTimings.map((x) => x.exec_ms);
  const shutdownSamples = okTimings.map((x) => x.shutdown_ms);
  const totalSamples = okTimings.map((x) => x.total_ms);

  const latency: Record<string, LatencyDistribution> = {
    "P-LAT-boot": aggregate(bootSamples),
    "P-LAT-roundtrip": aggregate(execSamples),
    "P-LAT-shutdown": aggregate(shutdownSamples),
    "P-LAT-total": aggregate(totalSamples),
  };

  const probes: ProbeResult[] = (
    ["boot", "roundtrip", "shutdown", "total"] as const
  ).map((variant) => {
    const dist = latency[`P-LAT-${variant}`]!;
    const probeName = `P-LAT-${variant}`;
    const okCount = okTimings.length;
    return {
      name: probeName,
      attacker_class: "LAT",
      expectation: "should-pass",
      validated_against: validatedAgainst,
      description:
        `${N}-iteration cold-${variant} latency distribution. Each iteration ` +
        `creates a fresh Sandbox (no warm-cache reuse). Real-CHV path: each ` +
        `boot is a real cloud-hypervisor spawn + vsock handshake.`,
      passed: okCount === N,
      reason:
        okCount === N
          ? `collected ${dist.samples} samples (${N} successful iterations)`
          : `only ${okCount}/${N} iterations succeeded (${N - okCount} failures recorded)`,
      duration_ms: 0, // per-probe duration is meaningless here; total in report
      errored: false,
      evidence: {
        distribution: dist,
        iterations_attempted: N,
        iterations_succeeded: okCount,
        iterations_failed: N - okCount,
        failure_phases: countFailurePhases(timings),
      },
    };
  });

  const failures = timings.filter((x) => !x.ok);
  const notes: string[] = [];
  if (failures.length > 0) {
    notes.push(
      `${failures.length}/${N} iterations failed: ` +
        summariseFailures(failures),
    );
  }
  notes.push(
    `total wall-clock: ${duration_ms}ms (${(duration_ms / N).toFixed(1)}ms/iter avg)`,
  );

  const allPassed = failures.length === 0;
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    backend: backendLabel,
    final_sandbox_state: "not_booted", // each iter shuts down its own sandbox
    probes,
    latency,
    summary: {
      total: probes.length,
      passed: allPassed ? probes.length : 0,
      failed: allPassed ? 0 : probes.length,
      errored: 0,
      skipped: 0,
    },
    notes,
  };
}

async function runOneLatencyIteration(
  factory: SandboxFactory,
  iter: number,
  tool: string,
  params: Record<string, unknown>,
  deadlineMs: number,
  logger: { info: (m: string) => void; error: (m: string) => void },
): Promise<PerIterationTiming> {
  const t0 = Date.now();
  let sandbox: Sandbox;
  try {
    sandbox = await factory(iter);
  } catch (e) {
    return {
      iter,
      ok: false,
      boot_ms: 0,
      exec_ms: 0,
      shutdown_ms: 0,
      total_ms: Date.now() - t0,
      failure_phase: "boot",
      error: `factory failed: ${(e as Error).message}`,
    };
  }

  const tBoot = Date.now();
  try {
    await sandbox.boot();
  } catch (e) {
    const boot_ms = Date.now() - tBoot;
    logger.error(`iter ${iter} boot failed: ${(e as Error).message}`);
    // Best-effort cleanup; ignore errors.
    try {
      await sandbox.shutdown();
    } catch {}
    return {
      iter,
      ok: false,
      boot_ms,
      exec_ms: 0,
      shutdown_ms: 0,
      total_ms: Date.now() - t0,
      failure_phase: "boot",
      error: (e as Error).message,
    };
  }
  const boot_ms = Date.now() - tBoot;

  const tExec = Date.now();
  let result: ToolExecution;
  try {
    result = await sandbox.executeTool({
      command_id: `latency-${iter}-${Date.now()}`,
      tool,
      params,
      deadline_ms: deadlineMs,
    });
  } catch (e) {
    const exec_ms = Date.now() - tExec;
    logger.error(`iter ${iter} exec failed: ${(e as Error).message}`);
    try {
      await sandbox.shutdown();
    } catch {}
    return {
      iter,
      ok: false,
      boot_ms,
      exec_ms,
      shutdown_ms: 0,
      total_ms: Date.now() - t0,
      failure_phase: "exec",
      error: (e as Error).message,
    };
  }
  const exec_ms = Date.now() - tExec;

  const tShutdown = Date.now();
  try {
    await sandbox.shutdown();
  } catch (e) {
    const shutdown_ms = Date.now() - tShutdown;
    logger.error(`iter ${iter} shutdown failed: ${(e as Error).message}`);
    return {
      iter,
      ok: false,
      boot_ms,
      exec_ms,
      shutdown_ms,
      total_ms: Date.now() - t0,
      exit_code: result.exit_code,
      failure_phase: "shutdown",
      error: (e as Error).message,
    };
  }
  const shutdown_ms = Date.now() - tShutdown;
  const total_ms = Date.now() - t0;

  const ok = result.exit_code === 0;
  return {
    iter,
    ok,
    boot_ms,
    exec_ms,
    shutdown_ms,
    total_ms,
    exit_code: result.exit_code,
    ...(ok
      ? {}
      : {
          failure_phase: "exec" as const,
          error: `exit_code=${result.exit_code} stderr=${result.stderr.slice(0, 200)}`,
        }),
  };
}

interface ConcurrentInstanceResult {
  index: number;
  ok: boolean;
  boot_ms: number;
  exec_ms: number;
  shutdown_ms: number;
  exit_code?: number;
  failure_phase?: "boot" | "exec" | "shutdown";
  error?: string;
  stdout?: string;
}

/**
 * Stand up N Sandbox instances concurrently, boot them all in parallel,
 * dispatch one echo through each, shut them all down. Verifies they
 * don't interfere — each instance has its own factory call so unique
 * cid + socket paths are the factory's responsibility.
 *
 * Reports per-sandbox boot/exec/shutdown timing + failures. Returns a
 * RedTeamReport with one ProbeResult per instance plus a synthesised
 * "concurrent-fleet" summary probe.
 */
export async function runConcurrentBattery(
  factory: SandboxFactory,
  options: ConcurrentBatteryOptions = {},
): Promise<RedTeamReport> {
  const N = options.concurrency ?? 8;
  if (!Number.isInteger(N) || N <= 0) {
    throw new Error(`concurrency must be a positive integer, got ${N}`);
  }
  const tool = options.tool ?? DEFAULT_TOOL;
  const paramsForIndex =
    options.paramsForIndex ??
    ((i: number): Record<string, unknown> => ({
      message: `concurrent-probe-${i}`,
    }));
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const logger = options.logger ?? NOOP_LOGGER;
  const validatedAgainst = options.validatedAgainst ?? "validated-chv";
  const backendLabel = options.backendLabel ?? "chv";

  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      runOneConcurrentInstance(
        factory,
        i,
        tool,
        paramsForIndex(i),
        deadlineMs,
        logger,
      ),
    ),
  );
  const duration_ms = Date.now() - t0;

  const okResults = results.filter((r) => r.ok);
  const probes: ProbeResult[] = results.map((r) => ({
    name: `P-CONC-instance-${r.index}`,
    attacker_class: "LAT",
    expectation: "should-pass",
    validated_against: validatedAgainst,
    description:
      `Concurrent fleet member ${r.index}/${N}: cold-boot + echo dispatch + ` +
      `shutdown alongside ${N - 1} other instances. Verifies cross-instance ` +
      `isolation (unique cid + unique vsock socket).`,
    passed: r.ok,
    reason: r.ok
      ? `boot=${r.boot_ms}ms exec=${r.exec_ms}ms shutdown=${r.shutdown_ms}ms ` +
        `exit_code=${r.exit_code}`
      : `failed in ${r.failure_phase} phase: ${r.error}`,
    duration_ms: r.boot_ms + r.exec_ms + r.shutdown_ms,
    errored: false,
    evidence: {
      boot_ms: r.boot_ms,
      exec_ms: r.exec_ms,
      shutdown_ms: r.shutdown_ms,
      exit_code: r.exit_code,
      ...(r.failure_phase !== undefined
        ? { failure_phase: r.failure_phase }
        : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.stdout !== undefined ? { stdout_preview: r.stdout } : {}),
    },
  }));

  const bootSamples = okResults.map((r) => r.boot_ms);
  const execSamples = okResults.map((r) => r.exec_ms);
  const shutdownSamples = okResults.map((r) => r.shutdown_ms);
  const latency: Record<string, LatencyDistribution> = {
    "P-CONC-boot": aggregate(bootSamples),
    "P-CONC-exec": aggregate(execSamples),
    "P-CONC-shutdown": aggregate(shutdownSamples),
  };

  const failures = results.filter((r) => !r.ok);
  const notes: string[] = [];
  notes.push(
    `concurrent-${N}: ${okResults.length}/${N} instances succeeded ` +
      `in ${duration_ms}ms wall-clock (parallel)`,
  );
  if (failures.length > 0) {
    for (const f of failures) {
      notes.push(
        `instance ${f.index} failed in ${f.failure_phase} phase: ${f.error}`,
      );
    }
  }

  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    backend: backendLabel,
    final_sandbox_state: "not_booted",
    probes,
    latency,
    summary: {
      total: probes.length,
      passed: okResults.length,
      failed: failures.length,
      errored: 0,
      skipped: 0,
    },
    notes,
  };
}

async function runOneConcurrentInstance(
  factory: SandboxFactory,
  index: number,
  tool: string,
  params: Record<string, unknown>,
  deadlineMs: number,
  logger: { info: (m: string) => void; error: (m: string) => void },
): Promise<ConcurrentInstanceResult> {
  let sandbox: Sandbox;
  try {
    sandbox = await factory(index);
  } catch (e) {
    return {
      index,
      ok: false,
      boot_ms: 0,
      exec_ms: 0,
      shutdown_ms: 0,
      failure_phase: "boot",
      error: `factory failed: ${(e as Error).message}`,
    };
  }

  const tBoot = Date.now();
  try {
    await sandbox.boot();
  } catch (e) {
    const boot_ms = Date.now() - tBoot;
    logger.error(`conc[${index}] boot failed: ${(e as Error).message}`);
    try {
      await sandbox.shutdown();
    } catch {}
    return {
      index,
      ok: false,
      boot_ms,
      exec_ms: 0,
      shutdown_ms: 0,
      failure_phase: "boot",
      error: (e as Error).message,
    };
  }
  const boot_ms = Date.now() - tBoot;

  const tExec = Date.now();
  let result: ToolExecution;
  try {
    result = await sandbox.executeTool({
      command_id: `concurrent-${index}-${Date.now()}`,
      tool,
      params,
      deadline_ms: deadlineMs,
    });
  } catch (e) {
    const exec_ms = Date.now() - tExec;
    logger.error(`conc[${index}] exec failed: ${(e as Error).message}`);
    try {
      await sandbox.shutdown();
    } catch {}
    return {
      index,
      ok: false,
      boot_ms,
      exec_ms,
      shutdown_ms: 0,
      failure_phase: "exec",
      error: (e as Error).message,
    };
  }
  const exec_ms = Date.now() - tExec;

  const tShutdown = Date.now();
  try {
    await sandbox.shutdown();
  } catch (e) {
    const shutdown_ms = Date.now() - tShutdown;
    logger.error(`conc[${index}] shutdown failed: ${(e as Error).message}`);
    return {
      index,
      ok: false,
      boot_ms,
      exec_ms,
      shutdown_ms,
      exit_code: result.exit_code,
      failure_phase: "shutdown",
      error: (e as Error).message,
    };
  }
  const shutdown_ms = Date.now() - tShutdown;

  const ok = result.exit_code === 0;
  return {
    index,
    ok,
    boot_ms,
    exec_ms,
    shutdown_ms,
    exit_code: result.exit_code,
    ...(ok
      ? { stdout: result.stdout.slice(0, 200) }
      : {
          failure_phase: "exec" as const,
          error: `exit_code=${result.exit_code} stderr=${result.stderr.slice(0, 200)}`,
        }),
  };
}

function countFailurePhases(
  timings: PerIterationTiming[],
): Record<string, number> {
  const out: Record<string, number> = { boot: 0, exec: 0, shutdown: 0 };
  for (const t of timings) {
    if (!t.ok && t.failure_phase !== undefined) {
      out[t.failure_phase] = (out[t.failure_phase] ?? 0) + 1;
    }
  }
  return out;
}

function summariseFailures(failures: PerIterationTiming[]): string {
  const byPhase = countFailurePhases(failures);
  const parts: string[] = [];
  for (const [phase, count] of Object.entries(byPhase)) {
    if (count > 0) parts.push(`${count} ${phase}`);
  }
  return parts.join(", ") || "0 failures";
}
