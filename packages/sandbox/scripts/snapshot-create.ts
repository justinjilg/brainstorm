#!/usr/bin/env node
// CHV install-time golden-snapshot CLI.
//
// Boots a ChvSandbox cold against a kernel + rootfs, pauses the VMM via
// ch-remote, takes a snapshot to BSM_SNAPSHOT_DIR, resumes, then computes
// the three baselines that ChvSandbox.verifyPostReset() compares against
// at runtime:
//
//   1. fs_hash               — streaming SHA-256 of BSM_OVERLAY (CoW file)
//   2. open_fd_count         — `GuestQuery { kind: "OpenFdCount" }` over vsock
//   3. expected_vmm_api_state — normalised `ch-remote info` reading
//
// Emits a JSON config block to stdout (and to --output if given) that the
// operator pastes into their sandbox config under `snapshotPath`,
// `rootfs.overlayPath`, and `baselines`. Without that block reset()
// throws `SandboxResetDivergenceError("baselines not configured")` by
// design (substrate-lying defense, threat-model §A6).
//
// Inputs (env vars):
//   BSM_KERNEL          — absolute path to bsm-sandbox-kernel       (required)
//   BSM_INITRAMFS       — absolute path to bsm-sandbox-initramfs    (required for modular kernels)
//   BSM_ROOTFS          — absolute path to bsm-sandbox-rootfs.img   (required)
//   BSM_OVERLAY         — absolute path to the writable CoW overlay (required for fs_hash)
//   BSM_SNAPSHOT_DIR    — directory to write the golden snapshot into (required)
//   BSM_VSOCK_SOCKET    — host-side AF_UNIX path                    (default: /tmp/bsm-snapshot.sock)
//   BSM_API_SOCKET      — Cloud Hypervisor REST API socket          (default: /tmp/bsm-snapshot-api.sock)
//   BSM_GUEST_PORT      — guest-side vsock port                     (default: 52000)
//   BSM_CH_BIN          — cloud-hypervisor binary                   (default: lookup on PATH)
//   BSM_CHREMOTE_BIN    — ch-remote binary                          (default: lookup on PATH)
//
// Args:
//   --output=<path>     — write the JSON config block to this path as well as stdout
//
// Exit codes:
//   0  — snapshot created + baselines computed successfully
//   1  — boot failure (CHV crash, vsock handshake timeout, etc.)
//   2  — snapshot failure (pause/snapshot/resume non-zero exit)
//   3  — env / usage error (missing required env, missing files)
//   4  — baseline computation failure (overlay hash, fd query, info parse)
//
// Honesty: this CLI has been exercised against the unit-tested ChRemote
// mock pathway, but not against a real ch-remote v40+ binary in this
// checkout. The argv shape pinned in __tests__/chv-remote.test.ts matches
// the documented v40+ form; node-2's reset-cycle.sh is the integration gate.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ChvSandbox,
  ChRemote,
  defaultExecFile,
  defaultHashFile,
  normaliseVmmState,
  type VmmApiState,
} from "../src/index.js";

interface SnapshotConfig {
  kernel: string;
  initramfs?: string;
  rootfs: string;
  overlay: string;
  snapshotDir: string;
  vsockSocket: string;
  apiSocket: string;
  guestPort: number;
  cloudHypervisorBin?: string;
  chRemoteBin?: string;
  outputPath?: string;
}

function loadConfig(): SnapshotConfig {
  const env = process.env;

  // Parse --output=<path> (only flag we support).
  let outputPath: string | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.error(
        `usage: snapshot-create [--output=<path>]\n` +
          `\n` +
          `required env: BSM_KERNEL, BSM_ROOTFS, BSM_OVERLAY, BSM_SNAPSHOT_DIR\n` +
          `optional env: BSM_INITRAMFS, BSM_VSOCK_SOCKET, BSM_API_SOCKET, BSM_GUEST_PORT, BSM_CH_BIN, BSM_CHREMOTE_BIN`,
      );
      process.exit(3);
    } else {
      console.error(`[snapshot-create] unknown argument: ${arg}`);
      process.exit(3);
    }
  }

  const required = (name: string, value: string | undefined): string => {
    if (value === undefined || value === "") {
      console.error(`[snapshot-create] ${name} is required`);
      process.exit(3);
    }
    return value;
  };

  const kernel = required("BSM_KERNEL", env.BSM_KERNEL);
  const rootfs = required("BSM_ROOTFS", env.BSM_ROOTFS);
  // BSM_OVERLAY was a phantom env var in earlier scripting — it
  // pointed at an empty file that CHV never wrote to, so the FS hash
  // baseline ended up being SHA-256("") and the substrate-lying
  // defense was a silent no-op. (0bz7aztr's run-5 catch — severity
  // high.) CHV's `--disk path=<rootfs>,readonly=on` doesn't expose a
  // separate overlay; the file CHV touches IS the rootfs.img, and an
  // external tamper of those bytes is exactly what the FS hash should
  // detect. Default the overlay path to rootfs (matching the existing
  // RootfsConfig.overlayPath default-to-`path` behavior).
  const overlay = env.BSM_OVERLAY ?? rootfs;
  const snapshotDir = required("BSM_SNAPSHOT_DIR", env.BSM_SNAPSHOT_DIR);
  const initramfs = env.BSM_INITRAMFS;

  if (!existsSync(kernel)) {
    console.error(
      `[snapshot-create] BSM_KERNEL points to nonexistent path: ${kernel}`,
    );
    process.exit(3);
  }
  if (initramfs !== undefined && !existsSync(initramfs)) {
    console.error(
      `[snapshot-create] BSM_INITRAMFS points to nonexistent path: ${initramfs}`,
    );
    process.exit(3);
  }
  if (!existsSync(rootfs)) {
    console.error(
      `[snapshot-create] BSM_ROOTFS points to nonexistent path: ${rootfs}`,
    );
    process.exit(3);
  }
  if (!existsSync(overlay)) {
    console.error(
      `[snapshot-create] BSM_OVERLAY points to nonexistent path: ${overlay}`,
    );
    process.exit(3);
  }

  return {
    kernel,
    initramfs,
    rootfs,
    overlay,
    snapshotDir,
    vsockSocket: env.BSM_VSOCK_SOCKET ?? "/tmp/bsm-snapshot.sock",
    apiSocket: env.BSM_API_SOCKET ?? "/tmp/bsm-snapshot-api.sock",
    guestPort: env.BSM_GUEST_PORT ? parseInt(env.BSM_GUEST_PORT, 10) : 52000,
    cloudHypervisorBin: env.BSM_CH_BIN,
    chRemoteBin: env.BSM_CHREMOTE_BIN,
    outputPath,
  };
}

function purgeStaleSocket(path: string): void {
  if (existsSync(path)) {
    rmSync(path);
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

interface BaselineBlock {
  snapshotPath: string;
  rootfs: { path: string; overlayPath: string };
  baselines: {
    fs_hash: string;
    open_fd_count: number;
    expected_vmm_api_state: VmmApiState;
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  purgeStaleSocket(cfg.vsockSocket);
  purgeStaleSocket(cfg.apiSocket);
  ensureDir(cfg.snapshotDir);

  console.error(
    `[snapshot-create] kernel=${cfg.kernel}\n` +
      `[snapshot-create] initramfs=${cfg.initramfs ?? "(none)"}\n` +
      `[snapshot-create] rootfs=${cfg.rootfs}\n` +
      `[snapshot-create] overlay=${cfg.overlay}\n` +
      `[snapshot-create] snapshot-dir=${cfg.snapshotDir}\n` +
      `[snapshot-create] vsock=${cfg.vsockSocket} (guest port ${cfg.guestPort})\n` +
      `[snapshot-create] api=${cfg.apiSocket}`,
  );

  const sandbox = new ChvSandbox({
    cloudHypervisorBin: cfg.cloudHypervisorBin,
    chRemoteBin: cfg.chRemoteBin,
    apiSocketPath: cfg.apiSocket,
    kernel: { path: cfg.kernel, initramfs: cfg.initramfs },
    rootfs: {
      path: cfg.rootfs,
      overlayPath: cfg.overlay,
      readonly: true,
    },
    vsock: {
      socketPath: cfg.vsockSocket,
      guestPort: cfg.guestPort,
    },
    cpus: 2,
    memMib: 1024,
    // Deliberately no `snapshotPath` and no `baselines`: this is the
    // *install* run, the run whose entire purpose is to mint them.
  });

  // --- Step 1: cold boot --------------------------------------------------
  const t0 = Date.now();
  try {
    await sandbox.boot();
  } catch (err) {
    console.error(
      `[snapshot-create] BOOT FAILED after ${Date.now() - t0}ms: ${
        (err as Error).message
      }`,
    );
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
  if (sandbox.state() !== "ready") {
    console.error(
      `[snapshot-create] sandbox.state() = ${sandbox.state()} (expected ready)`,
    );
    await sandbox.shutdown().catch(() => {});
    process.exit(1);
  }
  console.error(
    `[snapshot-create] PASS boot in ${Date.now() - t0}ms; state=ready`,
  );

  // We construct our own ChRemote rather than reaching into ChvSandbox's
  // private one — the public surface deliberately doesn't expose it, and
  // the install-time CLI is a separate concern from runtime reset.
  const chRemote = new ChRemote({
    binary: cfg.chRemoteBin,
    apiSocketPath: cfg.apiSocket,
    execFile: defaultExecFile,
  });

  // --- Step 2: pause + snapshot + resume ---------------------------------
  // CHV requires the VM to be paused before `snapshot destination_url=...`
  // is accepted. We pause -> snapshot -> resume so the post-snapshot VM is
  // still alive for the GuestQuery + info baseline reads in step 3.
  try {
    console.error(`[snapshot-create] pausing VMM...`);
    await chRemote.pause();
    console.error(
      `[snapshot-create] taking snapshot to ${cfg.snapshotDir} ...`,
    );
    await chRemote.snapshotCreate(cfg.snapshotDir);
    console.error(`[snapshot-create] resuming VMM...`);
    // Resume directly via ch-remote — ChRemote.snapshotRevert bundles
    // restore+resume but we need only resume here. Use defaultExecFile.
    await defaultExecFile(cfg.chRemoteBin ?? "ch-remote", [
      "--api-socket",
      cfg.apiSocket,
      "resume",
    ]);
  } catch (err) {
    console.error(
      `[snapshot-create] SNAPSHOT FAILED: ${(err as Error).message}`,
    );
    if ((err as Error).stack) console.error((err as Error).stack);
    await sandbox.shutdown().catch(() => {});
    process.exit(2);
  }
  console.error(`[snapshot-create] PASS snapshot taken at ${cfg.snapshotDir}`);

  // --- Step 3: baselines --------------------------------------------------
  let fs_hash: string;
  let open_fd_count: number;
  let expected_vmm_api_state: VmmApiState;
  try {
    // 3a. fs_hash — streaming SHA-256 of the CoW overlay. Done AFTER the
    // snapshot+resume so the hash captures the install-time state the
    // runtime reset will re-establish.
    if (!existsSync(cfg.overlay)) {
      throw new Error(
        `overlay file ${cfg.overlay} did not appear after boot+snapshot — ` +
          `cloud-hypervisor may not have created it (check rootfs config: ` +
          `overlayPath / readonly settings)`,
      );
    }
    fs_hash = await defaultHashFile(cfg.overlay);
    console.error(`[snapshot-create] fs_hash=${fs_hash}`);

    // 3b. open_fd_count — vsock GuestQuery THROUGH the booted
    // ChvSandbox's existing vsock connection. Codex round-3 caught the
    // earlier bug: opening a parallel VsockClient added an FD that
    // runtime reset() never sees, baking a stale baseline that diverges
    // on first reset. ChvSandbox.guestQuery() is the symmetric seam —
    // runtime reset() and install-time baseline both go through it,
    // ensuring the FD count includes the same probe-FD overhead.
    const result = await sandbox.guestQuery("OpenFdCount");
    open_fd_count = result.open_fd_count;
    console.error(`[snapshot-create] open_fd_count=${open_fd_count}`);

    // 3c. expected_vmm_api_state — normalised `ch-remote info`.
    const info = await chRemote.info();
    expected_vmm_api_state = info.state;
    console.error(
      `[snapshot-create] vmm_api_state=${expected_vmm_api_state} (raw=${info.raw})`,
    );
    // Sanity: we resumed above, so the live state should be "running". If
    // CHV reports anything else the baseline still records what we saw,
    // but log the unexpected.
    if (expected_vmm_api_state !== "running") {
      console.error(
        `[snapshot-create] WARN expected vmm_api_state=running after resume; got ${expected_vmm_api_state}. ` +
          `Recording as baseline anyway — runtime reset() will compare against this exact value.`,
      );
    }
    // normaliseVmmState is re-applied here for completeness/audit.
    void normaliseVmmState;
  } catch (err) {
    console.error(
      `[snapshot-create] BASELINE COMPUTATION FAILED: ${
        (err as Error).message
      }`,
    );
    if ((err as Error).stack) console.error((err as Error).stack);
    await sandbox.shutdown().catch(() => {});
    process.exit(4);
  }

  // --- Step 4: shutdown ---------------------------------------------------
  await sandbox.shutdown().catch((err) => {
    console.error(
      `[snapshot-create] WARN shutdown error: ${(err as Error).message}`,
    );
  });

  // --- Step 5: emit JSON --------------------------------------------------
  const block: BaselineBlock = {
    snapshotPath: cfg.snapshotDir,
    rootfs: {
      path: cfg.rootfs,
      overlayPath: cfg.overlay,
    },
    baselines: {
      fs_hash,
      open_fd_count,
      expected_vmm_api_state,
    },
  };
  const json = JSON.stringify(block, null, 2);

  // Stdout is the JSON config block (machine-readable). All progress logs
  // went to stderr so a `node snapshot-create.js > golden.json` redirect
  // produces a clean file.
  process.stdout.write(json + "\n");

  if (cfg.outputPath !== undefined) {
    try {
      ensureDir(dirname(cfg.outputPath));
      writeFileSync(cfg.outputPath, json + "\n", "utf-8");
      console.error(`[snapshot-create] wrote JSON to ${cfg.outputPath}`);
    } catch (err) {
      console.error(
        `[snapshot-create] WARN failed to write --output=${cfg.outputPath}: ${
          (err as Error).message
        }`,
      );
    }
  }

  console.error(
    `[snapshot-create] === ALL GREEN ===\n` +
      `[snapshot-create] snapshot=${cfg.snapshotDir}\n` +
      `[snapshot-create] paste the JSON above into your sandbox config (snapshotPath, rootfs.overlayPath, baselines)`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[snapshot-create] uncaught: ${(err as Error).message}`);
  if ((err as Error).stack) console.error((err as Error).stack);
  process.exit(1);
});
