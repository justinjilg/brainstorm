// Sandbox errors. Modelled after the protocol error codes in
// docs/endpoint-agent-protocol-v1.md so callers (the endpoint dispatcher)
// can map straight from `error.code` to a `CommandResult.error.code`.
//
// Honesty requirement: if a backend cannot run on the current host (e.g.
// Cloud Hypervisor on Darwin), it MUST throw `SandboxNotAvailableError`
// from `boot()` rather than pretending the VM came up.

export class SandboxError extends Error {
  /** Stable code consumable by the dispatcher and audit log. */
  public readonly code: string;
  public readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Thrown when a backend's prerequisites cannot be met on the current host.
 * The Linux/CHV backend throws this on Darwin; a future Linux runner
 * environment is expected to satisfy the prereqs and avoid the throw.
 */
export class SandboxNotAvailableError extends SandboxError {
  constructor(message: string, cause?: unknown) {
    super("SANDBOX_NOT_AVAILABLE", message, cause);
    this.name = "SandboxNotAvailableError";
  }
}

/** Boot failed (kernel/rootfs/vsock setup, VMM did not come up). */
export class SandboxBootError extends SandboxError {
  constructor(message: string, cause?: unknown) {
    super("SANDBOX_BOOT_FAILED", message, cause);
    this.name = "SandboxBootError";
  }
}

/**
 * Tool execution exceeded the caller-supplied deadline. The dispatcher
 * maps this to `lifecycle_state: "timed_out"` per protocol §6.
 */
export class SandboxToolTimeoutError extends SandboxError {
  public readonly deadline_ms: number;
  constructor(deadline_ms: number, message: string) {
    super("SANDBOX_TOOL_TIMEOUT", message);
    this.name = "SandboxToolTimeoutError";
    this.deadline_ms = deadline_ms;
  }
}

/** Tool ran but returned a non-zero exit code or guest-side runtime error. */
export class SandboxToolError extends SandboxError {
  public readonly exit_code: number;
  constructor(exit_code: number, message: string) {
    super("SANDBOX_TOOL_ERROR", message);
    this.name = "SandboxToolError";
    this.exit_code = exit_code;
  }
}

/**
 * Reset machinery itself failed (snapshot revert errored, vsock died, etc.).
 * Distinct from `SANDBOX_RESET_DIVERGENCE` which is "reset ran but the
 * 3-source verification disagreed" — see threat model §5.1.
 */
export class SandboxResetError extends SandboxError {
  constructor(message: string, cause?: unknown) {
    super("SANDBOX_RESET_FAILED", message, cause);
    this.name = "SandboxResetError";
  }
}

/**
 * Reset ran but the 3-source post-reset verification (FS hash + open-fd +
 * VMM API state) detected divergence. Per threat model §5.1 the integrity
 * monitor halts and the agent enters degraded mode.
 */
export class SandboxResetDivergenceError extends SandboxError {
  constructor(message: string, cause?: unknown) {
    super("SANDBOX_RESET_DIVERGENCE", message, cause);
    this.name = "SandboxResetDivergenceError";
  }
}

/**
 * Cloud Hypervisor's vsock-over-AF_UNIX bridge expects the host side to
 * write `CONNECT <port>\n` and then read `OK <sourcePort>\n` (success) or
 * any other line (failure). This error covers both:
 *   - the socket connected but CHV refused the CONNECT (anything other
 *     than `OK <port>\n`),
 *   - the handshake reply was malformed or the peer hung up mid-handshake.
 *
 * Distinct from `SandboxNotAvailableError` (which means we couldn't even
 * reach the AF_UNIX socket) — handshake errors imply CHV is up but the
 * vsock port is unreachable / not listening / wrong protocol.
 */
export class SandboxVsockHandshakeError extends SandboxError {
  constructor(message: string, cause?: unknown) {
    super("SANDBOX_VSOCK_HANDSHAKE_FAILED", message, cause);
    this.name = "SandboxVsockHandshakeError";
  }
}

/**
 * A length-prefixed vsock frame declared a payload larger than the
 * configured cap (default 16 MiB). Per protocol §6 (`FRAME_TOO_LARGE`),
 * we drop the frame and treat the connection as poisoned — the safe
 * action is to close + reboot the sandbox rather than try to skip past
 * `length` bytes from a possibly-malicious peer.
 */
export class SandboxVsockFrameTooLargeError extends SandboxError {
  public readonly declared_length: number;
  public readonly max_length: number;
  constructor(declared_length: number, max_length: number, message?: string) {
    super(
      "SANDBOX_VSOCK_FRAME_TOO_LARGE",
      message ??
        `vsock frame declared length ${declared_length} bytes exceeds cap ${max_length}`,
    );
    this.name = "SandboxVsockFrameTooLargeError";
    this.declared_length = declared_length;
    this.max_length = max_length;
  }
}
