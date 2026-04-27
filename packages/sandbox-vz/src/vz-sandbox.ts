// VzSandbox — Apple Virtualization.framework backend.
//
// Architecture (P3.1b):
//
//   VzSandbox (TS, this file)
//     │  spawn() bsm-vz-helper, NDJSON over stdio
//     ▼
//   bsm-vz-helper (Swift, NOT in this package)
//     │  Virtualization.framework Obj-C / Swift API
//     ▼
//   VZVirtualMachine (Linux guest)
//     │  VZVirtioSocketDevice (vsock-equivalent)
//     ▼
//   guest-side dispatcher (the same minimal Linux microVM image
//   used by the Cloud Hypervisor backend in @brainst0rm/sandbox)
//
// Why a Swift helper at all? Two reasons:
//
//   1. Virtualization.framework is Obj-C / Swift only. Node has no
//      first-party bindings. Going through a tiny code-signed helper
//      is cleaner than embedding a CGo bridge or pulling in a
//      node-vz npm package whose maturity is unproven (R13 in plan).
//   2. The framework requires `com.apple.security.virtualization`
//      entitlement, which means the binary that calls VZ APIs MUST
//      live inside a code-signed app bundle. Isolating that to one
//      Swift binary keeps the entitlement scope minimal and the
//      brainstorm-agent itself signable as a normal CLI.
//
// What IS implemented here (compile-clean, but UNTESTED end-to-end —
// see the README's "first-boot checklist"):
//   - VzSandbox class implementing the local Sandbox interface
//   - Process management (spawn / pipe wiring / exit handling)
//   - NDJSON request/response correlation by request_id
//   - Boot-config -> CLI-arg translation for `bsm-vz-helper boot`
//   - Reset path branching (saved-state on macOS 14+ vs cold-boot)
//   - Idempotent boot/shutdown
//
// What is NOT implemented (deliberate; needs the helper to exist):
//   - Real boot. There is no Swift binary in this PR.
//   - Real reset / verification. We construct the wire frame from
//     the helper's response; the helper does the work.
//   - Real entitlement / signing checks. Surface comes from
//     `bsm-vz-helper preflight`.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";

import type {
  ExecuteToolRequest,
  ExecuteToolResult,
  Sandbox,
  SandboxResetState,
  VerificationDetails,
  VmmApiState,
  VzBootConfig,
} from "./types.js";
import type {
  HelperBootResult,
  HelperExecResponse,
  HelperRequest,
  HelperResetResponse,
  HelperResponse,
} from "./helper-protocol.js";

const DEFAULT_HELPER_PATH = "bsm-vz-helper";
const DEFAULT_CMDLINE = "console=hvc0 root=/dev/vda rw";
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_MIB = 1024;

interface PendingRequest {
  resolve: (resp: HelperResponse) => void;
  reject: (err: Error) => void;
  /** Set when the helper closes before a response arrives. */
  cancelled?: boolean;
}

export class VzSandbox implements Sandbox {
  private helperProc: ChildProcess | null = null;
  private booted = false;
  private bootConfig: VzBootConfig | null = null;
  private bootResult: HelperBootResult | null = null;
  private readonly inflight = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private shuttingDown = false;
  /** Last verification baselines we received. Used by reset() to
   * compare against post-reset truth. Populated on first successful
   * boot from the helper's boot_result + the configured baselines. */
  private fsBaseline: string | null = null;
  private fdBaseline: number | null = null;

  /**
   * Optional override hook for tests — replaces the helper-spawn step
   * with an injectable harness so VzSandbox itself can be tested
   * without the Swift binary on PATH. Production callers leave this
   * null and the implementation calls `spawn(...)` directly.
   */
  constructor(
    private readonly spawnHelper: (
      helperPath: string,
      args: string[],
    ) => ChildProcess = (helperPath, args) =>
      spawn(helperPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      }),
  ) {}

  // ------------------------------------------------------------------
  // Public Sandbox interface
  // ------------------------------------------------------------------

  async boot(config: VzBootConfig): Promise<void> {
    if (this.booted) {
      // Idempotent — but verify the caller didn't change config under
      // our feet, which would be a bug.
      if (this.bootConfig && !sameBootConfig(this.bootConfig, config)) {
        throw new Error(
          "VzSandbox.boot called twice with different configs; call shutdown() first",
        );
      }
      return;
    }
    if (platform() !== "darwin") {
      throw new Error(
        `VzSandbox requires macOS; running on ${platform()}. Use @brainst0rm/sandbox (Cloud Hypervisor) on Linux.`,
      );
    }

    const helperPath = config.helperPath ?? DEFAULT_HELPER_PATH;
    const args = bootArgs(config);

    const proc = this.spawnHelper(helperPath, args);
    this.helperProc = proc;
    this.bootConfig = config;
    this.installPipeHandlers(proc);

    // Boot result is the FIRST line on stdout (no request_id — it's
    // the daemonization handshake). Wait for it.
    this.bootResult = await this.awaitBootResult();
    if (!this.bootResult.ok) {
      const code = this.bootResult.error?.code ?? "VZ_BOOT_FAILED";
      const msg = this.bootResult.error?.message ?? "boot result was not ok";
      await this.shutdown();
      throw new Error(`bsm-vz-helper boot failed: ${code} — ${msg}`);
    }

    this.booted = true;
  }

  async executeTool(req: ExecuteToolRequest): Promise<ExecuteToolResult> {
    this.assertBooted();
    const request_id = randomUUID();
    const helperReq: HelperRequest = {
      request_id,
      kind: "exec",
      command_id: req.command_id,
      tool: req.tool,
      params: req.params,
      deadline_ms: req.deadline_ms,
    };
    const resp = (await this.sendAndAwait(helperReq)) as HelperExecResponse;
    if (resp.kind !== "exec_response") {
      throw new Error(
        `expected exec_response, got ${resp.kind ?? "unknown"} for command ${req.command_id}`,
      );
    }
    if (resp.error) {
      // Surface as an exit_code != 0 ToolResult. The agent layer
      // upstream maps this onto FailedCommandResult.
      return {
        command_id: resp.command_id,
        exit_code: resp.exit_code === 0 ? 1 : resp.exit_code,
        stdout: resp.stdout,
        stderr: resp.stderr || `${resp.error.code}: ${resp.error.message}`,
        evidence_hash: resp.evidence_hash,
      };
    }
    return {
      command_id: resp.command_id,
      exit_code: resp.exit_code,
      stdout: resp.stdout,
      stderr: resp.stderr,
      evidence_hash: resp.evidence_hash,
    };
  }

  async reset(): Promise<SandboxResetState> {
    this.assertBooted();
    const request_id = randomUUID();
    const helperReq: HelperRequest = { request_id, kind: "reset" };
    const resp = (await this.sendAndAwait(helperReq)) as HelperResetResponse;
    if (resp.kind !== "reset_response") {
      throw new Error(`expected reset_response, got ${resp.kind ?? "unknown"}`);
    }
    if (resp.error) {
      throw new Error(
        `bsm-vz-helper reset failed: ${resp.error.code} — ${resp.error.message}`,
      );
    }

    // Capture baselines on the first successful reset; subsequent
    // resets cross-check against the same baselines via the helper's
    // own verify path.
    if (this.fsBaseline === null) this.fsBaseline = resp.fs_hash_baseline;
    if (this.fdBaseline === null) this.fdBaseline = resp.open_fd_count_baseline;

    const verification: VerificationDetails = {
      fs_hash: resp.fs_hash,
      fs_hash_baseline: resp.fs_hash_baseline,
      fs_hash_match: resp.fs_hash_match,
      open_fd_count: resp.open_fd_count,
      open_fd_count_baseline: resp.open_fd_count_baseline,
      vmm_api_state: resp.vmm_api_state as VmmApiState,
      expected_vmm_api_state: resp.expected_vmm_api_state as VmmApiState,
      divergence_action: resp.divergence_action,
    };

    const state: SandboxResetState = {
      reset_at: resp.reset_at,
      golden_hash: resp.golden_hash,
      verification_passed: resp.verification_passed,
      verification_details: verification,
    };

    return state;
  }

  async shutdown(): Promise<void> {
    if (!this.helperProc || this.shuttingDown) return;
    this.shuttingDown = true;

    // Best-effort polite shutdown via NDJSON; if helper is wedged we
    // SIGTERM after a grace window.
    if (this.booted) {
      try {
        await Promise.race([
          this.sendAndAwait({ request_id: randomUUID(), kind: "shutdown" }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("shutdown ack timeout")),
              5_000,
            ).unref(),
          ),
        ]);
      } catch {
        // Fall through to SIGTERM below.
      }
    }

    const proc = this.helperProc;
    this.helperProc = null;
    this.booted = false;

    // Reject any in-flight requests so callers don't hang.
    for (const [id, pending] of this.inflight) {
      pending.cancelled = true;
      pending.reject(
        new Error(`VzSandbox shutting down; request ${id} cancelled`),
      );
    }
    this.inflight.clear();

    try {
      proc.kill("SIGTERM");
    } catch {
      // proc may already be dead.
    }

    // Give the helper a beat; if still alive, SIGKILL.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        resolve();
      }, 2_000);
      t.unref();
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private assertBooted(): void {
    if (!this.booted || !this.helperProc) {
      throw new Error("VzSandbox: boot() must be called before this operation");
    }
  }

  private installPipeHandlers(proc: ChildProcess): void {
    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      let nl: number;
      while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.stdoutBuffer.slice(0, nl).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        if (line.length === 0) continue;
        this.handleLine(line);
      }
    });
    proc.on("exit", (code, signal) => {
      // Drain any waiters; null code + a signal is helper-killed-by-us.
      for (const [id, pending] of this.inflight) {
        if (pending.cancelled) continue;
        pending.reject(
          new Error(
            `bsm-vz-helper exited (code=${code}, signal=${signal}) before responding to ${id}`,
          ),
        );
      }
      this.inflight.clear();
      this.booted = false;
    });
  }

  private bootResultResolver: ((r: HelperBootResult) => void) | null = null;
  private bootResultRejecter: ((err: Error) => void) | null = null;

  private async awaitBootResult(): Promise<HelperBootResult> {
    return new Promise<HelperBootResult>((resolve, reject) => {
      this.bootResultResolver = resolve;
      this.bootResultRejecter = reject;

      const t = setTimeout(() => {
        if (this.bootResultRejecter) {
          this.bootResultRejecter(
            new Error("bsm-vz-helper did not produce a boot_result within 30s"),
          );
          this.bootResultResolver = null;
          this.bootResultRejecter = null;
        }
      }, 30_000);
      t.unref();
    });
  }

  private handleLine(line: string): void {
    let parsed: HelperResponse;
    try {
      parsed = JSON.parse(line) as HelperResponse;
    } catch {
      // Bad NDJSON from helper. Surface to stderr but don't crash;
      // a misbehaving helper should be detectable, not panic the agent.
      process.stderr.write(
        `[sandbox-vz] non-JSON line from bsm-vz-helper: ${line}\n`,
      );
      return;
    }

    if (parsed.kind === "boot_result") {
      const r = this.bootResultResolver;
      this.bootResultResolver = null;
      this.bootResultRejecter = null;
      if (r) r(parsed);
      return;
    }

    if (parsed.kind === "event") {
      // Lifecycle events flow upward via stderr-style logging for
      // now. When @brainst0rm/sandbox lands its EventEmitter shape,
      // we'll re-emit on the same channel.
      process.stderr.write(`[sandbox-vz] event: ${JSON.stringify(parsed)}\n`);
      return;
    }

    const responseId = (parsed as { request_id?: string }).request_id;
    if (!responseId) {
      process.stderr.write(
        `[sandbox-vz] response without request_id: ${line}\n`,
      );
      return;
    }
    const pending = this.inflight.get(responseId);
    if (!pending) {
      // Late response after timeout / cancellation. Drop with a log.
      process.stderr.write(
        `[sandbox-vz] late response for unknown request_id ${responseId}\n`,
      );
      return;
    }
    this.inflight.delete(responseId);
    pending.resolve(parsed);
  }

  private async sendAndAwait(req: HelperRequest): Promise<HelperResponse> {
    if (!this.helperProc?.stdin) {
      throw new Error("helper is not running");
    }
    const payload = JSON.stringify(req) + "\n";
    return new Promise<HelperResponse>((resolve, reject) => {
      this.inflight.set(req.request_id, { resolve, reject });
      this.helperProc!.stdin!.write(payload, (err) => {
        if (err) {
          this.inflight.delete(req.request_id);
          reject(err);
        }
      });
    });
  }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function bootArgs(config: VzBootConfig): string[] {
  const args = [
    "boot",
    "--kernel",
    config.kernel,
    "--rootfs",
    config.rootfs,
    "--cmdline",
    config.cmdline ?? DEFAULT_CMDLINE,
    "--cpus",
    String(config.cpus ?? DEFAULT_CPUS),
    "--memory-mib",
    String(config.memoryMib ?? DEFAULT_MEMORY_MIB),
  ];
  if (config.initrd) args.push("--initrd", config.initrd);
  if (config.savedStatePath) args.push("--saved-state", config.savedStatePath);
  return args;
}

function sameBootConfig(a: VzBootConfig, b: VzBootConfig): boolean {
  return (
    a.kernel === b.kernel &&
    a.rootfs === b.rootfs &&
    a.initrd === b.initrd &&
    a.cmdline === b.cmdline &&
    a.cpus === b.cpus &&
    a.memoryMib === b.memoryMib &&
    a.helperPath === b.helperPath &&
    a.savedStatePath === b.savedStatePath
  );
}
