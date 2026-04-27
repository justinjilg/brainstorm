#!/usr/bin/env node
// brainstorm-endpoint-stub — bootstrap + run a stub endpoint against a relay.
//
// Bootstrap flow:
//   1. Operator (admin) issues a bootstrap token via the relay's HTTP
//      /v1/admin/endpoint/enroll endpoint
//   2. Operator hands the bootstrap token + tenant pubkey to this binary
//      via env or CLI args
//   3. This binary generates a keypair (or reuses a persisted one),
//      enrolls via /v1/endpoint/enroll, then connects to /v1/endpoint/connect
//      and runs the dispatch loop
//
// Required environment variables:
//   BRAINSTORM_RELAY_URL_WS         — e.g. "ws://127.0.0.1:8443"
//   BRAINSTORM_RELAY_URL_HTTP       — e.g. "http://127.0.0.1:8444"
//   BRAINSTORM_ENDPOINT_BOOTSTRAP   — bootstrap token from admin
//   BRAINSTORM_ENDPOINT_TENANT_ID   — tenant id matching the bootstrap
//   BRAINSTORM_ENDPOINT_ID          — endpoint UUID matching the bootstrap
//   BRAINSTORM_ENDPOINT_TENANT_PUBKEY_HEX — hex Ed25519 public key for sig verify
//
// Optional:
//   BRAINSTORM_ENDPOINT_IDENTITY_PATH — defaults to ~/.brainstorm/endpoint-stub/identity.json

import { join } from "node:path";
import { homedir } from "node:os";

import {
  ChvSandboxExecutor,
  EndpointStub,
  type ToolExecutor,
} from "./index.js";

interface Config {
  wsUrl: string;
  httpUrl: string;
  bootstrap: string;
  tenantId: string;
  endpointId: string;
  tenantPublicKey: Uint8Array;
  identityPath: string;
}

function loadConfig(): Config {
  const env = process.env;
  const wsUrl = env.BRAINSTORM_RELAY_URL_WS;
  const httpUrl = env.BRAINSTORM_RELAY_URL_HTTP;
  const bootstrap = env.BRAINSTORM_ENDPOINT_BOOTSTRAP;
  const tenantId = env.BRAINSTORM_ENDPOINT_TENANT_ID;
  const endpointId = env.BRAINSTORM_ENDPOINT_ID;
  const pubkeyHex = env.BRAINSTORM_ENDPOINT_TENANT_PUBKEY_HEX;

  if (!wsUrl) throw new Error("BRAINSTORM_RELAY_URL_WS is required");
  if (!httpUrl) throw new Error("BRAINSTORM_RELAY_URL_HTTP is required");
  if (!bootstrap) throw new Error("BRAINSTORM_ENDPOINT_BOOTSTRAP is required");
  if (!tenantId) throw new Error("BRAINSTORM_ENDPOINT_TENANT_ID is required");
  if (!endpointId) throw new Error("BRAINSTORM_ENDPOINT_ID is required");
  if (!pubkeyHex)
    throw new Error("BRAINSTORM_ENDPOINT_TENANT_PUBKEY_HEX is required");

  const identityPath =
    env.BRAINSTORM_ENDPOINT_IDENTITY_PATH ??
    join(homedir(), ".brainstorm", "endpoint-stub", "identity.json");

  return {
    wsUrl,
    httpUrl,
    bootstrap,
    tenantId,
    endpointId,
    tenantPublicKey: hexToBytes(pubkeyHex),
    identityPath,
  };
}

async function enrollIfNeeded(args: {
  httpUrl: string;
  bootstrap: string;
  stub: EndpointStub;
}): Promise<void> {
  const pubkeyB64 = await args.stub.publicKeyB64();
  const resp = await fetch(args.httpUrl + "/v1/endpoint/enroll", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.bootstrap}`,
    },
    body: JSON.stringify({
      public_key: pubkeyB64,
      os: process.platform,
      arch: process.arch,
      agent_version: "endpoint-stub-0.1.0",
    }),
  });
  if (resp.status === 200) {
    console.log("[endpoint-stub] enrollment successful");
    return;
  }
  if (resp.status === 409) {
    // Already consumed — endpoint was likely enrolled previously; that's
    // fine if the persisted identity still has the matching keypair.
    console.log(
      "[endpoint-stub] bootstrap already consumed — using persisted identity",
    );
    return;
  }
  const text = await resp.text();
  throw new Error(`enrollment failed: ${resp.status} ${text}`);
}

/**
 * If BSM_USE_CHV_EXECUTOR=1, build a `ChvSandboxExecutor` from the
 * BSM_KERNEL / BSM_INITRAMFS / BSM_ROOTFS / BSM_VSOCK_SOCKET /
 * BSM_API_SOCKET / BSM_GUEST_PORT env contract — same as the
 * `first-light.sh` smoke test. Otherwise return undefined and let the
 * EndpointStub fall back to its built-in `stubExecutor`.
 *
 * Honesty: cold-boot-per-dispatch on Hetzner node-2 = ~600ms latency
 * floor. The README documents this. Don't enable BSM_USE_CHV_EXECUTOR
 * for a workload that needs sub-100ms tool dispatch.
 */
function loadChvExecutorIfRequested(): ToolExecutor | undefined {
  const env = process.env;
  if (env.BSM_USE_CHV_EXECUTOR !== "1") return undefined;

  const kernel = env.BSM_KERNEL;
  const initramfs = env.BSM_INITRAMFS;
  const rootfs = env.BSM_ROOTFS;
  if (kernel === undefined) {
    throw new Error(
      "BSM_USE_CHV_EXECUTOR=1 but BSM_KERNEL is unset (path to bsm-sandbox-kernel)",
    );
  }
  if (rootfs === undefined) {
    throw new Error(
      "BSM_USE_CHV_EXECUTOR=1 but BSM_ROOTFS is unset (path to bsm-sandbox-rootfs.img)",
    );
  }

  const vsockSocket = env.BSM_VSOCK_SOCKET ?? "/tmp/bsm-endpoint-stub.sock";
  const apiSocket = env.BSM_API_SOCKET ?? "/tmp/bsm-endpoint-stub-api.sock";
  let guestPort = 52000;
  if (env.BSM_GUEST_PORT !== undefined) {
    const parsed = parseInt(env.BSM_GUEST_PORT, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(
        `BSM_GUEST_PORT must be a positive integer (1-65535); got '${env.BSM_GUEST_PORT}'`,
      );
    }
    guestPort = parsed;
  }

  console.log(
    `[endpoint-stub] BSM_USE_CHV_EXECUTOR=1 — wiring ChvSandboxExecutor\n` +
      `[endpoint-stub]   kernel=${kernel}\n` +
      `[endpoint-stub]   initramfs=${initramfs ?? "(none)"}\n` +
      `[endpoint-stub]   rootfs=${rootfs}\n` +
      `[endpoint-stub]   vsock=${vsockSocket} (guest port ${guestPort})\n` +
      `[endpoint-stub]   api=${apiSocket}\n` +
      `[endpoint-stub]   pattern=cold-boot-per-dispatch (~600ms latency floor)`,
  );

  const executor = new ChvSandboxExecutor({
    config: {
      cloudHypervisorBin: env.BSM_CH_BIN,
      chRemoteBin: env.BSM_CHREMOTE_BIN,
      apiSocketPath: apiSocket,
      kernel: { path: kernel, initramfs },
      rootfs: { path: rootfs, readonly: true },
      vsock: {
        socketPath: vsockSocket,
        guestPort,
      },
      cpus: 2,
      memMib: 1024,
    },
  });
  return executor.execute;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const executor = loadChvExecutorIfRequested();
  const stub = new EndpointStub({
    relayUrl: config.wsUrl,
    tenantId: config.tenantId,
    identityPath: config.identityPath,
    endpointId: config.endpointId,
    tenantPublicKey: config.tenantPublicKey,
    executor,
  });
  await enrollIfNeeded({
    httpUrl: config.httpUrl,
    bootstrap: config.bootstrap,
    stub,
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[endpoint-stub] received ${signal}, shutting down`);
    await stub.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await stub.run();
  console.log("[endpoint-stub] connection closed");
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}

main().catch((err) => {
  console.error(`[endpoint-stub] fatal: ${(err as Error).message}`);
  process.exit(1);
});
