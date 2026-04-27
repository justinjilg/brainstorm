// ChvSandboxExecutor — bridges the endpoint-stub's pluggable
// `ToolExecutor` interface to a real `ChvSandbox` from
// `@brainst0rm/sandbox`.
//
// This is the seam Phase 1 (operator → relay → endpoint-stub) and
// Phase 3 (real ChvSandbox booting microVMs) cross. With this in
// place, a CommandEnvelope received over the relay actually runs
// inside an isolated CHV guest instead of bouncing off `stubExecutor`'s
// echo-back.
//
// Design choice: COLD-BOOT-PER-DISPATCH.
//
//   For every tool dispatch we:
//     1. Construct a fresh `ChvSandbox` from the configured paths.
//     2. `boot()` it (~600ms on Hetzner node-2 per PR #277).
//     3. `executeTool({ command_id, tool, params, deadline_ms })`.
//     4. `shutdown()` on every exit path — success, executor-failure,
//        and even unexpected throw.
//
//   Trade-offs:
//     + Honest about cost (no hidden pool-warm-up amortisation).
//     + Zero steady-state RAM — sandboxes only exist during a dispatch.
//     + No shared-state-between-tools concerns; each invocation gets a
//       provably-fresh guest.
//     + Failure modes are local: a boot failure on one dispatch doesn't
//       poison subsequent dispatches.
//     − ~600ms cold-boot floor on every command. Operators dispatching
//       many commands in tight succession will feel it.
//     − Higher per-host CPU cost during bursts (parallel boots).
//
//   The pool pattern (N pre-booted sandboxes, take/dispatch/reset/return)
//   is the documented next step. It trades steady-state RAM for ~2-30ms
//   per-dispatch latency. We're deferring it until we have real dispatch-
//   rate data to size the pool against.
//
// What this executor does NOT do (honest gaps):
//   - Per-tool timeout enforcement above the sandbox's own `deadline_ms`.
//     The sandbox itself enforces the deadline; we don't add a parallel
//     wall-clock fence on the executor side.
//   - Queueing under load. If 10 dispatches arrive simultaneously we boot
//     10 CHV processes in parallel. The relay is serialising for now.
//   - Shared image-pool optimisation. Each boot loads the kernel/initramfs/
//     rootfs from disk — `posix_fadvise(POSIX_FADV_WILLNEED)` and a
//     shared image cache would reduce IO under load.
//   - Reset between commands. Cold-boot-per-dispatch makes reset moot
//     (each command gets a fresh sandbox); when we move to a pool,
//     `reset()` becomes mandatory.

import {
  ChvSandbox,
  type ChvSandboxConfig,
  type Sandbox,
  type ToolExecution,
} from "@brainst0rm/sandbox";

import type {
  ToolExecutor,
  ToolExecutorContext,
  ToolExecutorResult,
} from "./index.js";

/**
 * Factory shape: given a config, produce a Sandbox. Production passes
 * `defaultSandboxFactory` which constructs a `ChvSandbox`. Tests inject
 * a mock factory that returns an in-memory Sandbox stub.
 */
export type SandboxFactory = (config: ChvSandboxConfig) => Sandbox;

/**
 * Default factory: constructs a `ChvSandbox` from the supplied config.
 * Exposed so callers can compose it with their own deps if needed.
 */
export const defaultSandboxFactory: SandboxFactory = (config) =>
  new ChvSandbox(config);

export interface ChvSandboxExecutorOptions {
  /**
   * Configuration handed to every fresh `ChvSandbox` boot. Holds kernel
   * / initramfs / rootfs / vsock-socket / api-socket paths plus
   * baselines and snapshot path. This config is reused for every
   * dispatch — the sandbox constructor is called with the same config
   * for each cold-boot, so any mutable state (e.g. `apiSocketPath`) MUST
   * be safe to reuse across boots. The default first-light setup with
   * unique sockets per boot is the supported pattern.
   *
   * Tip: when running the executor inside a long-lived process (the
   * endpoint-stub bin), prefer pointing `apiSocketPath` and
   * `vsock.socketPath` at the same paths every boot — `ChvSandbox.boot()`
   * purges any stale socket file before binding, so reuse is safe.
   */
  config: ChvSandboxConfig;
  /**
   * Override the sandbox factory (tests). Production callers leave
   * this undefined and get the real `ChvSandbox`.
   */
  factory?: SandboxFactory;
  /**
   * Optional logger (mirrors the rest of the package's logger shape).
   * Defaults to console with a `[chv-executor]` prefix.
   */
  logger?: { info: (m: string) => void; error: (m: string) => void };
}

/**
 * `ToolExecutor` implementation backed by a real CHV microVM.
 *
 * Construct once with a config; the resulting object's `.execute` is
 * the `ToolExecutor` callable. A typical wiring:
 *
 *   const executor = new ChvSandboxExecutor({ config });
 *   const stub = new EndpointStub({ ..., executor: executor.execute });
 *
 * For a one-liner you can pass `executor.execute` directly — the class
 * deliberately bundles the bound function as a field so it stays a
 * stable reference across passes.
 */
export class ChvSandboxExecutor {
  private readonly options: ChvSandboxExecutorOptions;
  private readonly factory: SandboxFactory;
  private readonly log: {
    info: (m: string) => void;
    error: (m: string) => void;
  };

  /**
   * Bound executor function suitable for handing straight to
   * `EndpointStub`. Stable identity across calls — useful when callers
   * want to swap executors based on env state.
   */
  public readonly execute: ToolExecutor;

  constructor(options: ChvSandboxExecutorOptions) {
    this.options = options;
    this.factory = options.factory ?? defaultSandboxFactory;
    this.log = options.logger ?? {
      info: (m) => console.log(`[chv-executor] ${m}`),
      error: (m) => console.error(`[chv-executor] ${m}`),
    };
    this.execute = (ctx) => this.dispatch(ctx);
  }

  /**
   * Cold-boot a fresh sandbox, run the tool inside it, shut it down.
   *
   * Mapping `ToolExecutorContext` → `Sandbox.executeTool`:
   *   - command_id          → ToolInvocation.command_id (forwarded as-is)
   *   - tool                → ToolInvocation.tool       (forwarded as-is)
   *   - params              → ToolInvocation.params     (forwarded as-is)
   *   - deadline_ms         → ToolInvocation.deadline_ms (sandbox enforces)
   *
   * Mapping `ToolExecution` → `ToolExecutorResult`:
   *   - exit_code           → exit_code (faithful)
   *   - stdout              → stdout    (faithful)
   *   - stderr              → stderr    (faithful)
   *   - evidence_hash       → dropped (the dispatcher computes its own
   *                           host-side hash; sandbox-side digests are
   *                           a future enhancement once the guest emits
   *                           them reliably)
   *
   * Error path translation (per requirement 4 in the wiring brief):
   *   - sandbox.boot() throws       → exit_code=126, stderr=boot-error msg.
   *                                   126 chosen to mirror POSIX "command
   *                                   found but not executable" semantics
   *                                   — the tool was real, the executor
   *                                   couldn't reach it.
   *   - sandbox.executeTool() throws → exit_code=125, stderr=exec-error msg.
   *                                   125 mirrors "executor itself failed"
   *                                   (git/run-parts convention).
   *   - sandbox.shutdown() throws    → logged, NOT propagated. We've
   *                                   already produced a result and
   *                                   reporting a shutdown failure as
   *                                   a tool failure would be wrong.
   *
   * Either way the EndpointStub turns a non-zero exit into a `failed`
   * CommandResult with `error.code = SANDBOX_TOOL_ERROR` (see
   * `handleCommandEnvelope` in index.ts), so the operator sees a clean
   * failure rather than a stuck spinner.
   *
   * Honesty: shutdown happens in `finally`, so even an unexpected throw
   * from the result-translation path can't leak a CHV process.
   */
  private async dispatch(
    ctx: ToolExecutorContext,
  ): Promise<ToolExecutorResult> {
    const t0 = Date.now();
    const sandbox = this.factory(this.options.config);

    let booted = false;
    try {
      try {
        await sandbox.boot();
        booted = true;
      } catch (e) {
        const msg = (e as Error).message;
        this.log.error(`boot failed for command ${ctx.command_id}: ${msg}`);
        return {
          exit_code: 126,
          stdout: "",
          stderr: `chv-executor: sandbox boot failed: ${msg}`,
        };
      }

      const bootMs = Date.now() - t0;
      this.log.info(
        `booted in ${bootMs}ms for command ${ctx.command_id} (cold-boot-per-dispatch — ~600ms is the honest floor)`,
      );

      let exec: ToolExecution;
      try {
        exec = await sandbox.executeTool({
          command_id: ctx.command_id,
          tool: ctx.tool,
          params: ctx.params,
          deadline_ms: ctx.deadline_ms,
        });
      } catch (e) {
        const msg = (e as Error).message;
        this.log.error(
          `executeTool failed for command ${ctx.command_id}: ${msg}`,
        );
        return {
          exit_code: 125,
          stdout: "",
          stderr: `chv-executor: sandbox executeTool failed: ${msg}`,
        };
      }

      const totalMs = Date.now() - t0;
      this.log.info(
        `command ${ctx.command_id} exit=${exec.exit_code} total=${totalMs}ms (boot=${bootMs}ms)`,
      );

      return {
        exit_code: exec.exit_code,
        stdout: exec.stdout,
        stderr: exec.stderr,
      };
    } finally {
      // Shutdown on every path. If we never booted, shutdown() is still
      // safe — the Sandbox interface documents it as idempotent.
      try {
        await sandbox.shutdown();
      } catch (e) {
        // Don't shadow the result we already produced; log and swallow.
        this.log.error(
          `shutdown failed for command ${ctx.command_id}` +
            `${booted ? "" : " (sandbox never booted)"}` +
            `: ${(e as Error).message}`,
        );
      }
    }
  }
}
