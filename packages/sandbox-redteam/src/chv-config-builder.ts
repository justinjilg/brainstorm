// Build a `ChvSandboxConfig` from the same env-var contract that
// `packages/sandbox/scripts/first-light.sh` uses. Keeping this in lock-step
// with first-light means 0bz7aztr's bring-up muscle memory carries over
// directly: any host that already passed first-light can run the red-team
// battery with the same exported env.
//
// Inputs (matches first-light.ts loadConfig()):
//   BSM_KERNEL          — absolute path to bsm-sandbox-kernel       (required)
//   BSM_INITRAMFS       — absolute path to bsm-sandbox-initramfs    (optional but
//                         required for modular kernels like Alpine virt)
//   BSM_ROOTFS          — absolute path to bsm-sandbox-rootfs.img   (required)
//   BSM_VSOCK_SOCKET    — host-side AF_UNIX path for CHV vsock      (default
//                         /tmp/bsm-redteam.sock — distinct from first-light's
//                         to avoid stomping concurrent runs)
//   BSM_API_SOCKET      — Cloud Hypervisor REST API socket          (default
//                         /tmp/bsm-redteam-api.sock)
//   BSM_GUEST_PORT      — guest-side vsock port for vsock-init      (default 52000,
//                         image-builder default)
//   BSM_CH_BIN          — cloud-hypervisor binary                   (default: lookup
//                         on PATH at boot)
//   BSM_CHREMOTE_BIN    — ch-remote binary                          (default: lookup
//                         on PATH at boot)
//
// `buildChvConfig()` is intentionally pure (returns a config object) — it does
// not check filesystem existence; that's the caller's job. The lat-only and
// concurrent runners do the filesystem check once up-front so a single bad
// path produces a single clear error rather than 1000 boot failures.

import { existsSync } from "node:fs";

import type { ChvSandboxConfig } from "@brainst0rm/sandbox";

export interface ChvBuilderEnv {
  BSM_KERNEL?: string;
  BSM_INITRAMFS?: string;
  BSM_ROOTFS?: string;
  BSM_VSOCK_SOCKET?: string;
  BSM_API_SOCKET?: string;
  BSM_GUEST_PORT?: string;
  BSM_CH_BIN?: string;
  BSM_CHREMOTE_BIN?: string;
  // For concurrent mode, callers pass the per-instance socket paths and CID
  // explicitly via overrides — this keeps the env var contract identical to
  // first-light while letting the runner shard.
}

export interface ChvBuilderOverrides {
  /** Override the host-side vsock socket path. */
  vsockSocketPath?: string;
  /** Override the CHV REST API socket path. */
  apiSocketPath?: string;
  /** Override the guest-side vsock CID. CHV requires CID >= 3. */
  cid?: number;
  /** Override the guest-side vsock port. */
  guestPort?: number;
}

export interface BuiltChvConfig {
  /** The `ChvSandboxConfig` ready to hand to `new ChvSandbox(config)`. */
  config: ChvSandboxConfig;
  /** Effective paths surfaced for logging/diagnostics. */
  effective: {
    kernel: string;
    initramfs?: string;
    rootfs: string;
    vsockSocket: string;
    apiSocket: string;
    guestPort: number;
    cid: number;
    cloudHypervisorBin?: string;
    chRemoteBin?: string;
  };
}

export const DEFAULT_VSOCK_SOCKET = "/tmp/bsm-redteam.sock";
export const DEFAULT_API_SOCKET = "/tmp/bsm-redteam-api.sock";
export const DEFAULT_GUEST_PORT = 52000;
export const DEFAULT_CID = 3;

/**
 * Build a `ChvSandboxConfig` from env (matches first-light.sh contract).
 * Throws a plain Error with a humane message if a required env var is
 * missing or points at a nonexistent path. Caller is expected to print
 * the message and exit 3 (matching first-light's "usage / config error"
 * exit code).
 */
export function buildChvConfig(
  env: ChvBuilderEnv = process.env as ChvBuilderEnv,
  overrides: ChvBuilderOverrides = {},
): BuiltChvConfig {
  const kernel = env.BSM_KERNEL;
  const initramfs = env.BSM_INITRAMFS;
  const rootfs = env.BSM_ROOTFS;
  if (kernel === undefined || kernel === "") {
    throw new Error(
      "BSM_KERNEL is required (path to bsm-sandbox-kernel produced by image-builder). " +
        "Run packages/image-builder/scripts/build.sh first.",
    );
  }
  if (rootfs === undefined || rootfs === "") {
    throw new Error(
      "BSM_ROOTFS is required (path to bsm-sandbox-rootfs.img produced by image-builder). " +
        "Run packages/image-builder/scripts/build.sh first.",
    );
  }
  if (!existsSync(kernel)) {
    throw new Error(`BSM_KERNEL points to nonexistent path: ${kernel}`);
  }
  if (!existsSync(rootfs)) {
    throw new Error(`BSM_ROOTFS points to nonexistent path: ${rootfs}`);
  }
  if (initramfs !== undefined && initramfs !== "" && !existsSync(initramfs)) {
    throw new Error(`BSM_INITRAMFS points to nonexistent path: ${initramfs}`);
  }

  const vsockSocket =
    overrides.vsockSocketPath ?? env.BSM_VSOCK_SOCKET ?? DEFAULT_VSOCK_SOCKET;
  const apiSocket =
    overrides.apiSocketPath ?? env.BSM_API_SOCKET ?? DEFAULT_API_SOCKET;
  const guestPort =
    overrides.guestPort ??
    (env.BSM_GUEST_PORT !== undefined && env.BSM_GUEST_PORT !== ""
      ? parseInt(env.BSM_GUEST_PORT, 10)
      : DEFAULT_GUEST_PORT);
  if (!Number.isFinite(guestPort) || guestPort <= 0 || guestPort > 65535) {
    throw new Error(
      `BSM_GUEST_PORT invalid: ${env.BSM_GUEST_PORT} (must be 1..65535)`,
    );
  }
  const cid = overrides.cid ?? DEFAULT_CID;
  if (!Number.isInteger(cid) || cid < 3) {
    throw new Error(
      `vsock CID must be an integer >= 3 (CIDs 0/1/2 are reserved); got ${cid}`,
    );
  }

  const config: ChvSandboxConfig = {
    cloudHypervisorBin: env.BSM_CH_BIN,
    chRemoteBin: env.BSM_CHREMOTE_BIN,
    apiSocketPath: apiSocket,
    kernel: {
      path: kernel,
      ...(initramfs !== undefined && initramfs !== "" ? { initramfs } : {}),
    },
    rootfs: { path: rootfs, readonly: true },
    vsock: {
      cid,
      socketPath: vsockSocket,
      guestPort,
    },
    cpus: 2,
    memMib: 1024,
  };

  return {
    config,
    effective: {
      kernel,
      ...(initramfs !== undefined && initramfs !== "" ? { initramfs } : {}),
      rootfs,
      vsockSocket,
      apiSocket,
      guestPort,
      cid,
      cloudHypervisorBin: env.BSM_CH_BIN,
      chRemoteBin: env.BSM_CHREMOTE_BIN,
    },
  };
}

/**
 * Per-instance overrides for concurrent mode. Given an instance index
 * (0-based) and the base socket paths, produces non-colliding paths and a
 * unique CID. CIDs are allocated as 3, 4, 5, ... by index — CHV reserves
 * 0/1/2.
 */
export function concurrentOverrides(
  index: number,
  baseVsock: string = DEFAULT_VSOCK_SOCKET,
  baseApi: string = DEFAULT_API_SOCKET,
): ChvBuilderOverrides {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`concurrent instance index must be >= 0, got ${index}`);
  }
  return {
    vsockSocketPath: shardSocketPath(baseVsock, index),
    apiSocketPath: shardSocketPath(baseApi, index),
    cid: 3 + index,
  };
}

/**
 * Insert `-N` before the `.sock` suffix (or append `.N` if no suffix).
 *   /tmp/bsm-redteam.sock   + 2 -> /tmp/bsm-redteam-2.sock
 *   /tmp/foo                + 5 -> /tmp/foo-5
 */
export function shardSocketPath(base: string, index: number): string {
  const suffix = ".sock";
  if (base.endsWith(suffix)) {
    return base.slice(0, -suffix.length) + `-${index}` + suffix;
  }
  return `${base}-${index}`;
}
