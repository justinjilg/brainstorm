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

import { EndpointStub } from "./index.js";

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

async function main(): Promise<void> {
  const config = loadConfig();
  const stub = new EndpointStub({
    relayUrl: config.wsUrl,
    tenantId: config.tenantId,
    identityPath: config.identityPath,
    endpointId: config.endpointId,
    tenantPublicKey: config.tenantPublicKey,
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
