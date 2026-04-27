// @brainst0rm/sandbox-vz — minimal inline Sandbox interface.
//
// HANDOFF NOTE: this interface is defined inline in this package so the
// macOS / Virtualization.framework track (P3.1b) can compile and ship a
// review-ready PR without depending on @brainst0rm/sandbox, which is
// being drafted in parallel by the P3.1a (Cloud Hypervisor / Linux) agent.
// When both worktrees merge, the orchestrator will:
//
//   1. Replace this file's `Sandbox` with `import type { Sandbox } from
//      "@brainst0rm/sandbox"` (production canonical interface).
//   2. Re-export `VzSandbox` as `class VzSandbox implements Sandbox`.
//   3. Drop the local re-declarations of SandboxResetState /
//      VerificationDetails / VmmApiState — those live in @brainst0rm/relay
//      already and are the wire-protocol contract; the local copies here
//      are *deliberately byte-equivalent* to the wire types so the
//      refactor is mechanical.
//
// Wire-protocol references (stay in sync — the shapes here MUST match):
//   - packages/relay/src/types.ts SandboxResetState, VerificationDetails,
//     VmmApiState
//   - docs/endpoint-agent-protocol-v1.md §13 (JSON schemas, normative)
//   - docs/endpoint-agent-threat-model.md §5 (3-source reset verification)

// VMM API state — common vocabulary across CHV (Linux) + VF (macOS); each
// backend translates from native state at its impl boundary.
//
// Apple Virtualization.framework native states map to this vocabulary as:
//   .stopped     -> "stopped"
//   .running     -> "running"
//   .paused      -> "paused"
//   .resuming    -> "running" (transient; report when settled)
//   .pausing     -> "paused" (transient; report when settled)
//   .stopping    -> "stopped" (transient; report when settled)
//   .error       -> "error"
//   .starting    -> "stopped" (we have NOT yet committed to running)
// (See VZVirtualMachineState in Apple's headers for the source list.)
export type VmmApiState = "running" | "stopped" | "paused" | "error";

// Mirrors @brainst0rm/relay SandboxResetState (wire-equivalent on purpose).
export interface SandboxResetState {
  reset_at: string;
  golden_hash: string;
  verification_passed: boolean;
  verification_details: VerificationDetails;
}

// Mirrors @brainst0rm/relay VerificationDetails (wire-equivalent on purpose).
// All three sources (FS hash, open-fd, VMM API state) are read independently
// and cross-checked per threat-model §5.1. Disagreement -> divergence_action
// = "halt" + caller transitions endpoint to degraded mode.
export interface VerificationDetails {
  fs_hash: string;
  fs_hash_baseline: string;
  fs_hash_match: boolean;
  open_fd_count: number;
  open_fd_count_baseline: number;
  vmm_api_state: VmmApiState;
  expected_vmm_api_state: VmmApiState;
  divergence_action: "none" | "halt";
}

// --- Boot config -----------------------------------------------------------

export interface VzBootConfig {
  /**
   * Path to the Linux kernel image (vmlinuz / Image). Apple VF requires
   * an explicit kernel — there is no firmware/BIOS-style boot for Linux
   * guests. ARM64 kernel for Apple Silicon hosts; x86_64 kernel for
   * Intel hosts (last supported on macOS 13).
   */
  kernel: string;
  /**
   * Optional initrd / initramfs image. Recommended: keep tools baked
   * directly into the rootfs to keep the image hash chain simple.
   */
  initrd?: string;
  /**
   * Path to the rootfs disk image (raw block image). Mounted as the
   * guest's primary VZVirtioBlockDevice.
   */
  rootfs: string;
  /**
   * Kernel command line. Defaults to "console=hvc0 root=/dev/vda rw".
   * The default assumes the guest's vsock console is hooked to hvc0
   * via the helper's serial config.
   */
  cmdline?: string;
  /** Number of vCPUs. Defaults to 2. */
  cpus?: number;
  /** RAM in MiB. Defaults to 1024. */
  memoryMib?: number;
  /**
   * Path to the helper binary. Defaults to "bsm-vz-helper" on PATH.
   * In production this is the code-signed binary inside the agent
   * .app bundle (see README — bundle layout).
   */
  helperPath?: string;
  /**
   * Path to a saved-state file produced by `bsm-vz-helper save-state`.
   * Present only on macOS 14 (Sonoma)+; if set, boot uses the fast
   * snapshot path. Absent -> cold boot. (D23: macOS 14+ for fast
   * snapshot; macOS 11+ cold-boot fallback.)
   */
  savedStatePath?: string;
  /**
   * Vsock CID assigned to the guest. Apple VF assigns CIDs per-VM; this
   * is the value the helper will report back via the `vsock_cid` field
   * of the boot result. Ignored if specified — kept for API symmetry
   * with @brainst0rm/sandbox (CHV).
   */
  vsockCid?: number;
}

// --- Tool execution --------------------------------------------------------

export interface ExecuteToolRequest {
  /** UUID minted by the relay; threaded through the entire chain. */
  command_id: string;
  /** Tool name as it appears in CommandEnvelope. */
  tool: string;
  /** Tool params (opaque to sandbox; deserialized by guest-side dispatcher). */
  params: Record<string, unknown>;
  /** Hard deadline. Helper enforces via timeout flag. */
  deadline_ms: number;
}

export interface ExecuteToolResult {
  command_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  /** sha256:... evidence chain digest computed inside the guest. */
  evidence_hash: string;
}

// --- The Sandbox interface (LOCAL, see top-of-file handoff note) ----------

export interface Sandbox {
  /**
   * Bring the microVM to a state where executeTool can be called.
   * For VZ this means: spawn helper, parse boot config, wait for the
   * vsock control channel to come up, send a ping over vsock, get pong.
   *
   * MUST be idempotent: a second call before shutdown returns the same
   * state (no double-boot). Implementations cache an internal `booted`
   * flag.
   */
  boot(config: VzBootConfig): Promise<void>;

  /**
   * Dispatch one tool to the running sandbox. The wire to the guest is
   * VZVirtioSocketDevice (vsock-equivalent). The helper proxies the
   * binary frames to/from the agent over its stdio pipe.
   */
  executeTool(req: ExecuteToolRequest): Promise<ExecuteToolResult>;

  /**
   * Return the sandbox to a known-clean state and emit verifiable
   * evidence of cleanliness. Per D13, called after every dispatch +
   * on suspicion. On macOS 14+ this is `restore-state`; on macOS 11-13
   * this is full cold-boot fallback.
   *
   * The returned SandboxResetState is what the agent stitches into
   * CompletedCommandResult.sandbox_reset_state on the wire.
   */
  reset(): Promise<SandboxResetState>;

  /**
   * Stop the helper, kill the VM. Idempotent: double-shutdown is a
   * no-op (logged at debug).
   */
  shutdown(): Promise<void>;
}
