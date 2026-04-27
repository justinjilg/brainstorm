// bsm-vz-helper — Swift binary CLI / IPC contract.
//
// `bsm-vz-helper` is a small Swift binary that owns the
// Virtualization.framework objects (VZVirtualMachineConfiguration,
// VZVirtualMachine, VZVirtioSocketDevice). It MUST run from a
// code-signed app bundle that carries the
// `com.apple.security.virtualization` entitlement (see README).
//
// The TypeScript side (VzSandbox in this package) speaks to the helper
// over the helper's stdio:
//
//   - One JSON request per line on stdin (newline-delimited JSON, NDJSON).
//   - One JSON response per line on stdout.
//   - Helper logs (operator-visible) on stderr, plain text.
//
// All wire frames carry `request_id` (UUID) so we can multiplex
// dispatches in flight. The guest-side vsock handshake is the helper's
// job; the TS side never speaks vsock directly.
//
// Subcommand surface (when invoked from a shell, not as a long-lived
// daemon — this is the UX the threat-model and ops docs reference):
//
//   bsm-vz-helper preflight
//     Print { "ok": bool, "macos_version": "14.4.1",
//             "arch": "arm64",
//             "fast_snapshot_supported": bool,
//             "entitlement_present": bool }
//     Exit 0 if usable for VzSandbox; non-zero with a human error if not.
//
//   bsm-vz-helper boot \
//     --kernel <path> \
//     --rootfs <path> \
//     [--initrd <path>] \
//     [--cmdline "<string>"] \
//     [--cpus N] \
//     [--memory-mib N] \
//     [--saved-state <path>]
//     Daemonize. Print one boot-result JSON line on stdout
//     (see `BootResult` below) then keep stdin/stdout open as the
//     control channel for further NDJSON requests:
//       { "request_id": "...", "kind": "exec",
//         "command_id": "...", "tool": "...", "params": {...},
//         "deadline_ms": 30000 }
//       { "request_id": "...", "kind": "reset" }
//       { "request_id": "...", "kind": "save_state",
//         "out_path": "..." }                  # macOS 14+ only
//       { "request_id": "...", "kind": "verify",
//         "fs_hash_baseline": "sha256:...",
//         "open_fd_count_baseline": N,
//         "expected_vmm_api_state": "running" }
//       { "request_id": "...", "kind": "shutdown" }
//
//     Each request gets exactly one response with the same request_id
//     (see `HelperResponse`).
//
//   bsm-vz-helper exec \
//     --command-id <uuid> \
//     --tool <name> \
//     --params <json> \
//     --deadline-ms <int>
//     Convenience one-shot (boot must already be running with
//     control-channel-mode helper). Forwards to a running helper via a
//     UNIX socket at $XDG_RUNTIME_DIR/bsm-vz-helper.sock; useful for
//     ops tools but the in-process VzSandbox uses NDJSON-over-stdio
//     directly.
//
//   bsm-vz-helper save-state --out <path>
//     macOS 14+ only. Calls -[VZVirtualMachine saveMachineStateTo:].
//
//   bsm-vz-helper restore-state --from <path>
//     macOS 14+ only. Calls -[VZVirtualMachine restoreMachineStateFrom:].
//     This is the fast-snapshot reset path (sub-second; cold-boot
//     fallback is ~3s).
//
// All long-running boot sessions emit unsolicited `event` frames on
// stdout for lifecycle transitions:
//   { "kind": "event",
//     "event": "vmm_state_changed",
//     "vmm_api_state": "running" | "stopped" | "paused" | "error",
//     "ts": "2026-04-27T..." }
//
// Helper exit codes (when running in non-daemon subcommands):
//   0   — success
//   64  — preflight failed (missing entitlement, unsupported macOS)
//   65  — boot config invalid (bad kernel path, etc.)
//   66  — VM lifecycle error (crash, hypervisor refused)
//   67  — guest unreachable on vsock
//   68  — reset verification divergence (RESET_VERIFICATION_DIVERGENCE)
//   69  — operation timed out
//   70  — internal helper bug

// --- Helper request/response wire shapes (NDJSON over stdio) --------------

export type HelperRequestKind =
  | "exec"
  | "reset"
  | "save_state"
  | "restore_state"
  | "verify"
  | "shutdown";

export interface HelperExecRequest {
  request_id: string;
  kind: "exec";
  command_id: string;
  tool: string;
  params: Record<string, unknown>;
  deadline_ms: number;
}

export interface HelperResetRequest {
  request_id: string;
  kind: "reset";
}

export interface HelperSaveStateRequest {
  request_id: string;
  kind: "save_state";
  out_path: string;
}

export interface HelperRestoreStateRequest {
  request_id: string;
  kind: "restore_state";
  from_path: string;
}

export interface HelperVerifyRequest {
  request_id: string;
  kind: "verify";
  fs_hash_baseline: string;
  open_fd_count_baseline: number;
  expected_vmm_api_state: "running" | "stopped" | "paused" | "error";
}

export interface HelperShutdownRequest {
  request_id: string;
  kind: "shutdown";
}

export type HelperRequest =
  | HelperExecRequest
  | HelperResetRequest
  | HelperSaveStateRequest
  | HelperRestoreStateRequest
  | HelperVerifyRequest
  | HelperShutdownRequest;

// --- Helper responses ------------------------------------------------------

export interface HelperBootResult {
  kind: "boot_result";
  ok: boolean;
  vsock_cid?: number;
  vmm_api_state: "running" | "stopped" | "paused" | "error";
  boot_path: "fast_snapshot" | "cold_boot";
  ts: string;
  error?: { code: string; message: string };
}

export interface HelperExecResponse {
  request_id: string;
  kind: "exec_response";
  command_id: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  evidence_hash: string;
  error?: { code: string; message: string };
}

export interface HelperResetResponse {
  request_id: string;
  kind: "reset_response";
  reset_at: string;
  golden_hash: string;
  verification_passed: boolean;
  // Verification fields are surfaced in the same shape as
  // VerificationDetails (see types.ts) so VzSandbox can pass through
  // unchanged.
  fs_hash: string;
  fs_hash_baseline: string;
  fs_hash_match: boolean;
  open_fd_count: number;
  open_fd_count_baseline: number;
  vmm_api_state: "running" | "stopped" | "paused" | "error";
  expected_vmm_api_state: "running" | "stopped" | "paused" | "error";
  divergence_action: "none" | "halt";
  reset_path: "fast_snapshot" | "cold_boot";
  error?: { code: string; message: string };
}

export interface HelperSaveStateResponse {
  request_id: string;
  kind: "save_state_response";
  ok: boolean;
  out_path: string;
  bytes_written?: number;
  error?: { code: string; message: string };
}

export interface HelperRestoreStateResponse {
  request_id: string;
  kind: "restore_state_response";
  ok: boolean;
  vmm_api_state: "running" | "stopped" | "paused" | "error";
  error?: { code: string; message: string };
}

export interface HelperVerifyResponse {
  request_id: string;
  kind: "verify_response";
  fs_hash: string;
  fs_hash_baseline: string;
  fs_hash_match: boolean;
  open_fd_count: number;
  open_fd_count_baseline: number;
  vmm_api_state: "running" | "stopped" | "paused" | "error";
  expected_vmm_api_state: "running" | "stopped" | "paused" | "error";
  divergence_action: "none" | "halt";
}

export interface HelperShutdownResponse {
  request_id: string;
  kind: "shutdown_response";
  ok: boolean;
}

export interface HelperEvent {
  kind: "event";
  event: "vmm_state_changed" | "guest_unreachable" | "helper_panic";
  vmm_api_state?: "running" | "stopped" | "paused" | "error";
  message?: string;
  ts: string;
}

export type HelperResponse =
  | HelperBootResult
  | HelperExecResponse
  | HelperResetResponse
  | HelperSaveStateResponse
  | HelperRestoreStateResponse
  | HelperVerifyResponse
  | HelperShutdownResponse
  | HelperEvent;

// Helper exit codes (mirror the comment block above so consumers can
// branch on numeric exits without parsing log text).
export const HELPER_EXIT_OK = 0;
export const HELPER_EXIT_PREFLIGHT_FAIL = 64;
export const HELPER_EXIT_BOOT_CONFIG_INVALID = 65;
export const HELPER_EXIT_VM_LIFECYCLE_ERROR = 66;
export const HELPER_EXIT_GUEST_UNREACHABLE = 67;
export const HELPER_EXIT_RESET_DIVERGENCE = 68;
export const HELPER_EXIT_TIMEOUT = 69;
export const HELPER_EXIT_INTERNAL_BUG = 70;
