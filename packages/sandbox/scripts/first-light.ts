#!/usr/bin/env node
// CHV first-light smoke test.
//
// Boots a ChvSandbox against artifacts produced by @brainst0rm/image-builder
// (kernel + rootfs.img with vsock-init as PID 1), runs an `echo` tool through
// the vsock dispatch path, and prints a structured PASS/FAIL summary.
//
// Inputs (env vars):
//   BSM_KERNEL          — absolute path to bsm-sandbox-kernel       (required)
//   BSM_INITRAMFS       — absolute path to bsm-sandbox-initramfs    (required for modular kernels like Alpine virt)
//   BSM_ROOTFS          — absolute path to bsm-sandbox-rootfs.img   (required)
//   BSM_VSOCK_SOCKET    — host-side AF_UNIX path for CHV vsock      (default: /tmp/bsm-firstlight.sock)
//   BSM_API_SOCKET      — Cloud Hypervisor REST API socket          (default: /tmp/bsm-firstlight-api.sock)
//   BSM_GUEST_PORT      — guest-side vsock port for vsock-init       (default: 52000, image-builder default)
//   BSM_CH_BIN          — cloud-hypervisor binary                   (default: lookup on PATH)
//   BSM_CHREMOTE_BIN    — ch-remote binary                          (default: lookup on PATH)
//
// Exit codes:
//   0  — boot reached state="ready" AND echo dispatch returned exit_code=0
//   1  — boot failed (CHV process crash, vsock handshake timeout, etc.)
//   2  — boot OK but executeTool failed
//   3  — usage / config error (missing required env)
//
// This is the bar from packages/sandbox/README.md "Linux runner first-light
// checklist" steps 5 + 6.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { ChvSandbox } from "../src/index.js";

interface FirstLightConfig {
  kernel: string;
  initramfs?: string;
  rootfs: string;
  vsockSocket: string;
  apiSocket: string;
  guestPort: number;
  cloudHypervisorBin?: string;
  chRemoteBin?: string;
}

function loadConfig(): FirstLightConfig {
  const env = process.env;
  const kernel = env.BSM_KERNEL;
  const initramfs = env.BSM_INITRAMFS;
  const rootfs = env.BSM_ROOTFS;
  if (!kernel) {
    console.error(
      "[firstlight] BSM_KERNEL is required (path to bsm-sandbox-kernel)",
    );
    process.exit(3);
  }
  if (!rootfs) {
    console.error(
      "[firstlight] BSM_ROOTFS is required (path to bsm-sandbox-rootfs.img)",
    );
    process.exit(3);
  }
  if (!existsSync(kernel)) {
    console.error(
      `[firstlight] BSM_KERNEL points to nonexistent path: ${kernel}`,
    );
    process.exit(3);
  }
  if (initramfs !== undefined && !existsSync(initramfs)) {
    console.error(
      `[firstlight] BSM_INITRAMFS points to nonexistent path: ${initramfs}`,
    );
    process.exit(3);
  }
  if (!existsSync(rootfs)) {
    console.error(
      `[firstlight] BSM_ROOTFS points to nonexistent path: ${rootfs}`,
    );
    process.exit(3);
  }
  return {
    kernel,
    initramfs,
    rootfs,
    vsockSocket: env.BSM_VSOCK_SOCKET ?? "/tmp/bsm-firstlight.sock",
    apiSocket: env.BSM_API_SOCKET ?? "/tmp/bsm-firstlight-api.sock",
    guestPort: env.BSM_GUEST_PORT ? parseInt(env.BSM_GUEST_PORT, 10) : 52000,
    cloudHypervisorBin: env.BSM_CH_BIN,
    chRemoteBin: env.BSM_CHREMOTE_BIN,
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

async function main(): Promise<void> {
  const cfg = loadConfig();
  purgeStaleSocket(cfg.vsockSocket);
  purgeStaleSocket(cfg.apiSocket);

  console.log(
    `[firstlight] kernel=${cfg.kernel}\n` +
      `[firstlight] initramfs=${cfg.initramfs ?? "(none)"}\n` +
      `[firstlight] rootfs=${cfg.rootfs}\n` +
      `[firstlight] vsock=${cfg.vsockSocket} (guest port ${cfg.guestPort})\n` +
      `[firstlight] api=${cfg.apiSocket}`,
  );

  const sandbox = new ChvSandbox({
    cloudHypervisorBin: cfg.cloudHypervisorBin,
    chRemoteBin: cfg.chRemoteBin,
    apiSocketPath: cfg.apiSocket,
    kernel: { path: cfg.kernel, initramfs: cfg.initramfs },
    rootfs: { path: cfg.rootfs, readonly: true },
    vsock: {
      socketPath: cfg.vsockSocket,
      guestPort: cfg.guestPort,
    },
    cpus: 2,
    memMib: 1024,
  });

  const t0 = Date.now();
  try {
    await sandbox.boot();
  } catch (err) {
    console.error(
      `[firstlight] BOOT FAILED after ${Date.now() - t0}ms: ${(err as Error).message}`,
    );
    if ((err as Error).stack) console.error((err as Error).stack);
    process.exit(1);
  }
  const bootMs = Date.now() - t0;
  if (sandbox.state() !== "ready") {
    console.error(
      `[firstlight] sandbox.state() = ${sandbox.state()} (expected ready)`,
    );
    await sandbox.shutdown().catch(() => {});
    process.exit(1);
  }
  console.log(`[firstlight] PASS boot in ${bootMs}ms; sandbox.state() = ready`);

  // --- echo dispatch round-trip ------------------------------------------
  const t1 = Date.now();
  let result;
  try {
    result = await sandbox.executeTool({
      command_id: `firstlight-${Date.now()}`,
      tool: "echo",
      params: { message: "hello-from-host" },
      deadline_ms: 30_000,
    });
  } catch (err) {
    console.error(
      `[firstlight] EXEC FAILED after ${Date.now() - t1}ms: ${(err as Error).message}`,
    );
    await sandbox.shutdown().catch(() => {});
    process.exit(2);
  }
  const execMs = Date.now() - t1;

  if (result.exit_code !== 0) {
    console.error(
      `[firstlight] echo returned exit_code=${result.exit_code}\n` +
        `  stdout: ${JSON.stringify(result.stdout)}\n` +
        `  stderr: ${JSON.stringify(result.stderr)}`,
    );
    await sandbox.shutdown().catch(() => {});
    process.exit(2);
  }

  console.log(
    `[firstlight] PASS exec in ${execMs}ms; exit_code=0\n` +
      `[firstlight]   stdout: ${result.stdout.trim()}`,
  );
  await sandbox.shutdown().catch(() => {});

  console.log(
    `[firstlight] === ALL GREEN ===\n` +
      `[firstlight] boot=${bootMs}ms exec=${execMs}ms total=${Date.now() - t0}ms`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[firstlight] uncaught: ${(err as Error).message}`);
  if ((err as Error).stack) console.error((err as Error).stack);
  process.exit(1);
});
