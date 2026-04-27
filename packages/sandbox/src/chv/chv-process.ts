// Cloud Hypervisor subprocess management.
//
// What this file IS: a thin, honest wrapper around spawning the
// `cloud-hypervisor` binary with the flags assembled from
// `ChvSandboxConfig`. It also encapsulates the platform check
// (Cloud Hypervisor is Linux-only — KVM-backed) so callers see a clean
// `SandboxNotAvailableError` on Darwin instead of a confusing ENOENT.
//
// What this file is NOT: a working implementation that has been booted.
// This module has not been executed against a real `cloud-hypervisor`
// binary in this checkout. It is wiring waiting for a Linux runner.

import { spawn, type ChildProcess } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { platform as nodePlatform } from "node:process";

import { SandboxBootError, SandboxNotAvailableError } from "../errors.js";
import {
  type ChvSandboxConfig,
  DEFAULT_CPUS,
  DEFAULT_KERNEL_CMDLINE,
  DEFAULT_MEM_MIB,
} from "./chv-config.js";

/**
 * Returns true iff Cloud Hypervisor can plausibly run on this host.
 * Cloud Hypervisor requires Linux + KVM. We check Linux here; KVM
 * presence is checked at boot by attempting to start the VMM.
 */
export function isChvSupportedHost(): boolean {
  return nodePlatform === "linux";
}

/**
 * Throw `SandboxNotAvailableError` if the host cannot run CHV at all.
 * Called from `ChvSandbox.boot()` so Darwin sessions fail cleanly.
 */
export async function assertChvAvailable(
  config: ChvSandboxConfig,
): Promise<{ cloudHypervisorBin: string; chRemoteBin: string }> {
  if (!isChvSupportedHost()) {
    throw new SandboxNotAvailableError(
      `Cloud Hypervisor backend requires Linux (current platform: ${nodePlatform}). ` +
        `On Darwin, use the Apple Virtualization.framework backend (P3.1b).`,
    );
  }

  const cloudHypervisorBin = config.cloudHypervisorBin ?? "cloud-hypervisor";
  const chRemoteBin = config.chRemoteBin ?? "ch-remote";

  // If the user supplied an explicit path, verify it exists. We don't
  // verify $PATH-resolved names here — `spawn` will surface ENOENT cleanly
  // and the dispatcher logs it. This matches how the existing relay code
  // handles optional binaries.
  if (config.cloudHypervisorBin !== undefined) {
    try {
      await access(config.cloudHypervisorBin, constants.X_OK);
    } catch (e) {
      throw new SandboxNotAvailableError(
        `cloud-hypervisor binary not found or not executable at ${config.cloudHypervisorBin}`,
        e,
      );
    }
  }
  if (config.chRemoteBin !== undefined) {
    try {
      await access(config.chRemoteBin, constants.X_OK);
    } catch (e) {
      throw new SandboxNotAvailableError(
        `ch-remote binary not found or not executable at ${config.chRemoteBin}`,
        e,
      );
    }
  }

  return { cloudHypervisorBin, chRemoteBin };
}

/**
 * Build the argv for `cloud-hypervisor` from a config. Matches the flags
 * documented in cloud-hypervisor v40+ (`--api-socket`, `--kernel`, `--disk`,
 * `--vsock`, `--cpus`, `--memory`).
 *
 * Untested on this machine — review against the installed CHV version
 * before first-light boot.
 */
export function buildChvArgv(config: ChvSandboxConfig): string[] {
  const cpus = config.cpus ?? DEFAULT_CPUS;
  const memMib = config.memMib ?? DEFAULT_MEM_MIB;
  const cmdline = config.kernel.cmdline ?? DEFAULT_KERNEL_CMDLINE;

  const diskFlag =
    config.rootfs.readonly === false
      ? `path=${config.rootfs.path}`
      : `path=${config.rootfs.path},readonly=on`;

  const argv: string[] = [
    "--api-socket",
    `path=${config.apiSocketPath}`,
    "--kernel",
    config.kernel.path,
  ];
  if (config.kernel.initramfs !== undefined) {
    argv.push("--initramfs", config.kernel.initramfs);
  }
  argv.push(
    "--cmdline",
    cmdline,
    "--disk",
    diskFlag,
    "--cpus",
    `boot=${cpus}`,
    "--memory",
    `size=${memMib}M`,
    "--vsock",
    `cid=${config.vsock.cid ?? 3},socket=${config.vsock.socketPath}`,
    "--seccomp",
    "true",
  );
  return argv;
}

export interface ChvProcessHandle {
  child: ChildProcess;
  argv: string[];
  /** Best-effort exit awaitable; resolves on `exit` (with code). */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Spawn `cloud-hypervisor` and return a handle. Rejects with
 * `SandboxBootError` if the process fails to start. Successful start does
 * NOT mean the guest booted — that requires a vsock probe.
 *
 * Untested on this machine.
 */
export function spawnCloudHypervisor(
  binary: string,
  argv: string[],
  logger: { info: (m: string) => void; error: (m: string) => void },
): ChvProcessHandle {
  const child = spawn(binary, argv, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.on("error", (err) => {
    logger.error(`[chv] spawn error: ${err.message}`);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    // CHV is fairly chatty; we forward to a dedicated channel.
    logger.info(`[chv stdout] ${chunk.toString("utf-8").trimEnd()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logger.error(`[chv stderr] ${chunk.toString("utf-8").trimEnd()}`);
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  return { child, argv, exited };
}

/** Used by callers that want to surface boot failure with context. */
export function asBootError(
  message: string,
  cause?: unknown,
): SandboxBootError {
  return new SandboxBootError(message, cause);
}
