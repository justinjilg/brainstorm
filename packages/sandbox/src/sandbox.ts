// The abstract Sandbox interface.
//
// Consumers: the endpoint dispatcher in P3.3 (Go, owned by crd4sdom) plus
// the TypeScript reference dispatcher (`@brainst0rm/endpoint-stub`, swap-in
// path during P3.3 integration).
//
// Both backends — Cloud Hypervisor (Linux, P3.1a, this package) and
// Apple Virtualization.framework (macOS, P3.1b, separate work) — must
// satisfy this surface so the dispatcher can be backend-agnostic. The
// production Go agent will mirror this interface in Go.
//
// Lifecycle (per docs/endpoint-agent-plan.md §5 and threat-model §4):
//
//   sandbox = createSandbox(...)
//   await sandbox.boot()                       // VM up, vsock channel open
//   for each dispatched command:
//     result = await sandbox.executeTool({...})
//     reset = await sandbox.reset()            // 3-source verified
//     // emit `sandbox_reset_state: reset` in the CommandResult
//   await sandbox.shutdown()
//
// Reset MUST run after every dispatch (D13: trigger=after-every-dispatch).
// Reset MUST produce a `ResetState` matching the protocol's
// `SandboxResetState` shape so it can be embedded verbatim in
// CommandResult frames.

import type {
  SandboxResetState,
  VerificationDetails,
  VmmApiState,
} from "@brainst0rm/relay";

// Re-export the protocol types so consumers of this package don't need
// a direct @brainst0rm/relay import just to type their result-handling.
export type { SandboxResetState, VerificationDetails, VmmApiState };

/** Local alias matching the relay name in plan/threat-model docs. */
export type ResetState = SandboxResetState;

/**
 * What the dispatcher hands to `executeTool`. Mirrors
 * `ToolExecutorContext` in `@brainst0rm/endpoint-stub` so the stub can be
 * adapted to drive a Sandbox in P3.3 with no shape change.
 */
export interface ToolInvocation {
  /** Stable id from the CommandEnvelope. Used for evidence-chain tagging. */
  command_id: string;
  /** Tool name as advertised by the image's tool registry (P3.4). */
  tool: string;
  /** Caller-validated tool params. The sandbox does NOT re-validate. */
  params: Record<string, unknown>;
  /**
   * Hard deadline in milliseconds. Backends MUST kill the in-guest process
   * if the deadline elapses and throw `SandboxToolTimeoutError`.
   */
  deadline_ms: number;
}

/**
 * Successful tool execution. Mirrors `ToolExecutorResult` in endpoint-stub.
 * Non-zero exit_code is allowed and is reported faithfully — it is the
 * dispatcher's call whether to treat it as a `failed` CommandResult.
 */
export interface ToolExecution {
  exit_code: number;
  stdout: string;
  stderr: string;
  /**
   * Optional per-execution evidence digest computed inside the guest
   * (per plan §6 audit). Backends may omit; the dispatcher will fall
   * back to a host-side hash of stdout||stderr.
   */
  evidence_hash?: string;
}

/**
 * Backend-agnostic factory result. Each concrete backend (CHV, VF) exposes
 * its own constructor — see `ChvSandbox` in `./chv/chv-sandbox`.
 */
export interface Sandbox {
  /** A short label used in logs and audit ("chv", "vf", etc.). */
  readonly backend: SandboxBackend;

  /**
   * Bring the VM up and open the vsock command channel.
   * Throws `SandboxNotAvailableError` if backend prereqs are missing on
   * this host (e.g. `cloud-hypervisor` binary on Darwin).
   * Throws `SandboxBootError` if prereqs are present but boot fails.
   * Idempotent: calling boot() on an already-booted sandbox is a no-op.
   */
  boot(): Promise<void>;

  /**
   * Execute a tool inside the booted sandbox.
   * Throws `SandboxNotAvailableError` if the sandbox is not booted.
   * Throws `SandboxToolTimeoutError` if `deadline_ms` elapses.
   * Returns a non-zero exit_code without throwing — the dispatcher decides.
   */
  executeTool(invocation: ToolInvocation): Promise<ToolExecution>;

  /**
   * Reset state: snapshot revert (or cold boot fallback) + 3-source
   * verification. Returns the `ResetState` to embed in the CommandResult.
   * If verification diverges, throws `SandboxResetDivergenceError` (the
   * dispatcher should mark the sandbox unhealthy and stop accepting
   * dispatches until an operator reviews — per threat-model §5.1).
   * If reset machinery itself errors, throws `SandboxResetError`.
   */
  reset(): Promise<ResetState>;

  /**
   * Stop the VM and release host resources. Idempotent. Safe to call from
   * a SIGTERM handler. Implementations should NOT reset before shutdown —
   * shutdown discards state by definition.
   */
  shutdown(): Promise<void>;

  /**
   * Cheap state probe. Used by HealthPong's `sandbox_state` field per
   * protocol §10. "ready" = booted + last reset verified;
   * "resetting" = a reset is currently in flight;
   * "failed" = boot failed or last reset diverged.
   */
  state(): SandboxState;
}

export type SandboxBackend = "chv" | "vf" | "stub";

export type SandboxState =
  | "not_booted"
  | "booting"
  | "ready"
  | "resetting"
  | "failed";

/**
 * Helper to build the `VerificationDetails` shape used in `ResetState`.
 * Default values produce a "passing" verification — concrete backends
 * compute the real values from FS hashing, in-guest fd counting, and
 * VMM API queries (per threat-model §5.1).
 */
export function makeVerificationDetails(input: {
  fs_hash: string;
  fs_hash_baseline: string;
  open_fd_count: number;
  open_fd_count_baseline: number;
  vmm_api_state: VmmApiState;
  expected_vmm_api_state: VmmApiState;
}): VerificationDetails {
  const fs_hash_match = input.fs_hash === input.fs_hash_baseline;
  const fd_match = input.open_fd_count === input.open_fd_count_baseline;
  const vmm_match = input.vmm_api_state === input.expected_vmm_api_state;
  const all_match = fs_hash_match && fd_match && vmm_match;
  return {
    fs_hash: input.fs_hash,
    fs_hash_baseline: input.fs_hash_baseline,
    fs_hash_match,
    open_fd_count: input.open_fd_count,
    open_fd_count_baseline: input.open_fd_count_baseline,
    vmm_api_state: input.vmm_api_state,
    expected_vmm_api_state: input.expected_vmm_api_state,
    divergence_action: all_match ? "none" : "halt",
  };
}
