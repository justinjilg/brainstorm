#!/usr/bin/env node
// brainstorm-relay — startup entry point.
//
// Wires every foundation module + WS binding + HTTP enrollment into a
// running service. MVP defaults: laptop loopback (127.0.0.1), self-signed
// or no TLS (caller handles TLS-termination via reverse proxy in dev).
//
// Configuration via environment variables (POSIX convention):
//
//   BRAINSTORM_RELAY_PORT_WS         — WebSocket port (default 8443)
//   BRAINSTORM_RELAY_PORT_HTTP       — Enrollment HTTP port (default 8444)
//   BRAINSTORM_RELAY_HOST            — bind host (default "127.0.0.1")
//   BRAINSTORM_RELAY_DATA_DIR        — SQLite + state directory (default "~/.brainstorm/relay")
//   BRAINSTORM_RELAY_ADMIN_TOKEN     — required for /v1/admin/* endpoints
//   BRAINSTORM_RELAY_TENANT_KEY_HEX  — Ed25519 private key for tenant-1 (32 bytes hex)
//                                       For MVP single-tenant; multi-tenant is post-MVP.
//   BRAINSTORM_RELAY_OPERATOR_API_KEY — operator api_key (any string, ≥16 chars).
//                                       Per protocol §3.2 mandate: the relay
//                                       derives the verify HMAC key via
//                                       HKDF-SHA-256(api_key, salt, info) at
//                                       boot. The SDK does the same on the
//                                       operator side, producing the same
//                                       32-byte key. Rotate this to rotate
//                                       the operator credential.
//   BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX — DEPRECATED 32-byte raw hex key.
//                                       Only consulted if API_KEY is not set,
//                                       used as-is (no HKDF). Kept for
//                                       backward-compat with pre-2026-04-28
//                                       deploys; will be removed in a future
//                                       release. Issue #288.
//   BRAINSTORM_RELAY_OPERATOR_ID     — operator id (default "operator@local")
//   BRAINSTORM_RELAY_TENANT_ID       — tenant id (default "tenant-local")

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

import { AuditLog } from "./audit.js";
import { NonceStore } from "./nonce-store.js";
import { SessionStore } from "./session-store.js";
import { LifecycleManager } from "./lifecycle.js";
import { ResultRouter } from "./result-router.js";
import { AckTimeoutManager } from "./ack-timeout.js";
import { DispatchOrchestrator } from "./dispatch.js";
import { RelayServer } from "./relay-server.js";
import { startWsBinding } from "./ws-binding.js";
import { EndpointRegistry, startEnrollmentHttp } from "./enrollment.js";
import { deriveOperatorHmacKey } from "./operator-key.js";

interface Config {
  wsPort: number;
  httpPort: number;
  host: string;
  dataDir: string;
  adminToken: string;
  tenantKeyBytes: Uint8Array;
  operatorHmacKey: Uint8Array;
  operatorId: string;
  tenantId: string;
}

function loadConfig(): Config {
  const dataDir =
    process.env.BRAINSTORM_RELAY_DATA_DIR ??
    join(homedir(), ".brainstorm", "relay");
  mkdirSync(dataDir, { recursive: true });

  const adminToken = process.env.BRAINSTORM_RELAY_ADMIN_TOKEN;
  if (!adminToken) {
    throw new Error(
      "BRAINSTORM_RELAY_ADMIN_TOKEN is required (set to a strong random value)",
    );
  }

  const tenantKeyHex = process.env.BRAINSTORM_RELAY_TENANT_KEY_HEX;
  if (!tenantKeyHex) {
    throw new Error(
      "BRAINSTORM_RELAY_TENANT_KEY_HEX is required (32 bytes hex, Ed25519 private key seed)",
    );
  }
  const tenantKeyBytes = hexToBytes(tenantKeyHex);
  if (tenantKeyBytes.length !== 32) {
    throw new Error(
      `BRAINSTORM_RELAY_TENANT_KEY_HEX must decode to 32 bytes; got ${tenantKeyBytes.length}`,
    );
  }

  // Per protocol §3.2: HMAC key MUST be derived symmetrically via HKDF
  // on both sides. Prefer BRAINSTORM_RELAY_OPERATOR_API_KEY (new): we
  // derive the 32-byte verify key from it at boot, matching what the
  // SDK does with the same api_key. Fall back to the legacy raw-hex
  // env var (treated as the final 32-byte key, no HKDF) for back-compat
  // with pre-2026-04-28 deploys. See issue #288.
  const operatorId =
    process.env.BRAINSTORM_RELAY_OPERATOR_ID ?? "operator@local";
  const tenantId = process.env.BRAINSTORM_RELAY_TENANT_ID ?? "tenant-local";

  const operatorApiKey = process.env.BRAINSTORM_RELAY_OPERATOR_API_KEY;
  let operatorHmacKey: Uint8Array;
  if (operatorApiKey) {
    if (operatorApiKey.length < 16) {
      throw new Error(
        `BRAINSTORM_RELAY_OPERATOR_API_KEY must be at least 16 chars; got ${operatorApiKey.length}`,
      );
    }
    operatorHmacKey = deriveOperatorHmacKey({
      apiKey: operatorApiKey,
      operatorId,
      tenantId,
    });
  } else {
    const operatorHmacHex = process.env.BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX;
    if (!operatorHmacHex) {
      throw new Error(
        "BRAINSTORM_RELAY_OPERATOR_API_KEY is required (preferred), or " +
          "the deprecated BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX (32 bytes hex)",
      );
    }
    operatorHmacKey = hexToBytes(operatorHmacHex);
    if (operatorHmacKey.length !== 32) {
      throw new Error(
        `BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX must decode to 32 bytes; got ${operatorHmacKey.length}`,
      );
    }
    console.warn(
      "[brainstorm-relay] WARNING: using deprecated BRAINSTORM_RELAY_OPERATOR_HMAC_KEY_HEX. " +
        "Migrate to BRAINSTORM_RELAY_OPERATOR_API_KEY (HKDF-derived per protocol §3.2). See issue #288.",
    );
  }

  return {
    wsPort: parseInt(process.env.BRAINSTORM_RELAY_PORT_WS ?? "8443", 10),
    httpPort: parseInt(process.env.BRAINSTORM_RELAY_PORT_HTTP ?? "8444", 10),
    host: process.env.BRAINSTORM_RELAY_HOST ?? "127.0.0.1",
    dataDir,
    adminToken,
    tenantKeyBytes,
    operatorHmacKey,
    operatorId,
    tenantId,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Foundation modules
  const audit = new AuditLog(join(config.dataDir, "audit.db"));
  const nonces = new NonceStore({ dbPath: join(config.dataDir, "nonces.db") });
  const sessions = new SessionStore();
  const lifecycle = new LifecycleManager();
  const router = new ResultRouter({ audit, sessions, lifecycle });
  const ackTimeout = new AckTimeoutManager({ timeoutMs: 5_000 });
  const registry = new EndpointRegistry({
    dbPath: join(config.dataDir, "endpoints.db"),
  });

  const dispatch = new DispatchOrchestrator({
    audit,
    nonces,
    sessions,
    lifecycle,
    tenantSigning: (tenant_id) =>
      tenant_id === config.tenantId
        ? {
            signing_key_id: `${config.tenantId}/key-v1`,
            private_key: config.tenantKeyBytes,
          }
        : null,
    endpointPublicKey: (endpoint_id) => registry.getPublicKey(endpoint_id),
  });

  const server = new RelayServer({
    audit,
    sessions,
    dispatch,
    router,
    ackTimeout,
    operatorHmacKey: (operator_id, tenant_id) =>
      operator_id === config.operatorId && tenant_id === config.tenantId
        ? config.operatorHmacKey
        : null,
    endpointPublicKey: (endpoint_id) => registry.getPublicKey(endpoint_id),
  });

  // Start HTTP enrollment service
  const httpHandle = await startEnrollmentHttp({
    port: config.httpPort,
    host: config.host,
    registry,
    adminToken: config.adminToken,
  });

  // Start WS service
  const wsHandle = await startWsBinding({
    port: config.wsPort,
    host: config.host,
    server,
    sessions,
    onConnection: (path, addr) => {
      console.log(`[relay] connection on ${path} from ${addr}`);
    },
  });

  console.log(
    `[relay] WS listening on ${config.host}:${wsHandle.port()} (paths /v1/operator, /v1/endpoint/connect)`,
  );
  console.log(
    `[relay] HTTP enrollment listening on ${config.host}:${httpHandle.port()}`,
  );
  console.log(`[relay] data dir: ${config.dataDir}`);
  console.log(
    `[relay] tenant_id: ${config.tenantId}, operator_id: ${config.operatorId}`,
  );

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[relay] received ${signal}, shutting down...`);
    ackTimeout.cancelAll();
    await Promise.allSettled([wsHandle.close(), httpHandle.close()]);
    audit.close();
    nonces.close();
    registry.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new Error("invalid hex string");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}

main().catch((err) => {
  console.error(`[relay] fatal: ${(err as Error).message}`);
  process.exit(1);
});
