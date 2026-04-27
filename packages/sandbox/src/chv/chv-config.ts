// Cloud Hypervisor configuration. The plan (§5, P3.1a) calls for:
//   - vsock for command/response channel between agent and guest
//   - virtio-fs for file inputs/outputs
//   - manual snapshot create/revert for reset machinery
//
// What's still open (gaps that block first-light):
//   - Kernel image source: do we ship a Brainstorm-built kernel or consume
//     one from the brainstormVM `vm.boot` baseline? See README "Linux runner
//     first-light checklist".
//   - Rootfs layout: P3.4 image-build pipeline produces this; until then the
//     `RootfsConfig.path` is treated as opaque to this package.
//   - vsock CID allocation: CID 2 is the host; CID 3+ is a guest. We pick
//     a per-instance CID at boot to allow multiple sandboxes per host
//     (post-MVP), defaulting to 3 for the single-sandbox case.

import type { VmmApiState } from "@brainst0rm/relay";

export interface KernelConfig {
  /** Absolute path to the kernel binary (vmlinux). */
  path: string;
  /**
   * Optional path to an initramfs image. Required if the kernel is
   * modular (e.g. Alpine virt) — the initramfs loads virtio-blk + ext4
   * before pivot_root. Image-builder produces `bsm-sandbox-initramfs`.
   * Without it, modular kernels panic on root-mount with
   * "List of all partitions: (empty)".
   */
  initramfs?: string;
  /** Kernel command-line. Defaults to a sensible quiet-boot string. */
  cmdline?: string;
}

export interface RootfsConfig {
  /**
   * Absolute path to the rootfs image (raw or qcow2). This is what
   * CHV's `--disk path=<file>,readonly=on` flag points at — also what
   * the substrate-lying defense's FS-hash check reads back. With
   * `readonly=on`, CHV does not write to this file; tamper from any
   * other source (host, co-resident process, etc.) will be detected.
   */
  path: string;
  /**
   * Optional override for which file the FS-hash verification reads.
   * Defaults to `path`. Only matters in advanced deployments where the
   * operator has set up a qcow2 backing-file layout or host-level
   * overlayfs at the host layer (CHV itself has no overlay-path concept
   * in `--disk`); in those cases the writable file is distinct from
   * the immutable base, and `overlayPath` must point at the writable
   * file or the substrate-lying defense will hash the immutable side
   * and miss tamper. Codex round-2 caught this as a configuration
   * trap; default-to-`path` makes the simple case correct without
   * configuration.
   */
  overlayPath?: string;
  /**
   * Whether the disk is mounted read-only inside the guest. Defaults true
   * — the golden image must be immutable; writes go to a CoW overlay
   * managed by the snapshot machinery (P3.2a, not yet implemented here).
   */
  readonly?: boolean;
}

export interface VsockConfig {
  /**
   * Guest CID. CID 0 (hypervisor), 1 (local), 2 (host) are reserved.
   * Use 3+ for guests. Default 3.
   */
  cid?: number;
  /**
   * Host-side Unix socket path used by Cloud Hypervisor's vsock device
   * to bridge into a host-visible AF_UNIX endpoint. Cloud Hypervisor
   * uses the `--vsock cid=N,socket=/path` flag.
   */
  socketPath: string;
  /**
   * Vsock port the in-guest dispatcher is listening on. Defaults to 1024
   * (matches `DEFAULT_GUEST_PORT` in vsock-client.ts and the protocol's
   * canonical port). Set to 52000 to match the image-builder vsock-init's
   * default; image-builder honours `BSM_VSOCK_PORT` env to align.
   */
  guestPort?: number;
}

export interface ChvSandboxConfig {
  /**
   * Path to the `cloud-hypervisor` binary. Defaults to looking up
   * `cloud-hypervisor` on PATH at boot time.
   */
  cloudHypervisorBin?: string;
  /**
   * Path to the `ch-remote` binary (used for snapshot/restore + VMM API
   * queries). Defaults to looking up `ch-remote` on PATH.
   */
  chRemoteBin?: string;
  /**
   * Cloud Hypervisor REST API socket. Used for `vm.info` queries (the
   * "VMM API state" verification source per threat-model §5.1).
   */
  apiSocketPath: string;
  kernel: KernelConfig;
  rootfs: RootfsConfig;
  vsock: VsockConfig;
  /** vCPUs to allocate. Defaults to 2. */
  cpus?: number;
  /** Memory in MiB. Defaults to 1024. */
  memMib?: number;
  /**
   * Path where the golden snapshot is written by the install-time setup
   * flow and reverted to between dispatches (P3.2a — not yet wired up
   * in this scaffolding). Required for reset-by-revert mode.
   */
  snapshotPath?: string;
  /**
   * Baseline values recorded at install-time, used by the 3-source
   * verification step. The integrity monitor compares post-reset
   * measurements against these. If unset, this package emits a
   * "verification_passed: true with sentinel zeros" reset state and
   * marks it clearly in stderr — caller MUST treat that as
   * "verification not yet wired up", not as a real pass.
   */
  baselines?: {
    fs_hash: string;
    open_fd_count: number;
    expected_vmm_api_state: VmmApiState;
  };
  /** Optional logger; defaults to console-prefixed. */
  logger?: { info: (m: string) => void; error: (m: string) => void };
}

// image-builder produces a raw whole-disk ext4 rootfs (no partition table),
// so /dev/vda is the filesystem itself. /dev/vda1 would be a partition that
// does not exist and triggers a VFS-unable-to-mount-root kernel panic.
// brainstormVM's own god-mode VMs use this same /dev/vda pattern.
//
// `rdinit=/init` tells the kernel to run /init from the initramfs (Alpine
// initramfs has /init as PID 1, which loads modules and pivot_roots to
// /dev/vda before exec'ing the rootfs's /sbin/init — i.e. our vsock-init).
//
// `rootfstype=ext4` is required because Alpine's initramfs init script
// invokes busybox mount without an explicit `-t`; without ROOTFSTYPE set,
// busybox tries to autodetect, which on a stock Alpine initramfs (which
// has ext4 as a separate kernel module rather than built-in) renders as
// "mount: mounting /dev/vda on /sysroot failed: No such file or directory"
// — exactly the symptom 0bz7aztr saw on first-light run #4.
export const DEFAULT_KERNEL_CMDLINE =
  "console=hvc0 root=/dev/vda rootfstype=ext4 ro rdinit=/init";
export const DEFAULT_VSOCK_CID = 3;
export const DEFAULT_CPUS = 2;
export const DEFAULT_MEM_MIB = 1024;
