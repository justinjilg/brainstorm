// P1.4 Stage 1.0 — laptop loopback validation.
//
// Brings up the relay's WS server + HTTP enrollment server in-process,
// enrolls a fake endpoint (stand-in for brainstorm-agent / P1.3 owned by
// crd4sdom — not yet built), opens a real WebSocket to /v1/endpoint/connect
// with a valid connection_proof, opens an operator WS to /v1/operator,
// runs the full dispatch flow over real sockets, and verifies the result
// comes back to the operator.
//
// This is the end-to-end smoke test that proves Phase 1 P1.4 works on
// the loopback machine. Real `ws` library, real HTTP server, real SQLite.
// Only the brainstorm-agent role is simulated here (since crd4sdom owns
// the actual agent extension).

import { describe, it, expect, afterEach } from "vitest";
import * as ed25519 from "@noble/ed25519";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "@noble/hashes/sha256";

import { AuditLog } from "../audit.js";
import { NonceStore } from "../nonce-store.js";
import { SessionStore } from "../session-store.js";
import { LifecycleManager } from "../lifecycle.js";
import { ResultRouter } from "../result-router.js";
import { AckTimeoutManager } from "../ack-timeout.js";
import { DispatchOrchestrator } from "../dispatch.js";
import { RelayServer } from "../relay-server.js";
import { startWsBinding, type WsBindingHandle } from "../ws-binding.js";
import {
  EndpointRegistry,
  startEnrollmentHttp,
  type EnrollmentHttpHandle,
} from "../enrollment.js";
import { signingInput, SIGN_CONTEXT } from "../canonical.js";
import { operatorHmac } from "../signing.js";
import type {
  CommandEnvelope,
  CompletedCommandResult,
  EndpointHello,
  OperatorHello,
  DispatchRequest,
  ChangeSetPreview,
} from "../types.js";

const tempDirs: string[] = [];
const cleanupCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cb of cleanupCallbacks.reverse()) {
    try {
      await cb();
    } catch {}
  }
  cleanupCallbacks.length = 0;
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  tempDirs.length = 0;
});

function freshTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loopback-"));
  tempDirs.push(dir);
  return dir;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return Buffer.from(s, "binary").toString("base64");
}

interface LoopbackEnv {
  wsHandle: WsBindingHandle;
  httpHandle: EnrollmentHttpHandle;
  registry: EndpointRegistry;
  audit: AuditLog;
  tenantPrivKey: Uint8Array;
  operatorHmacKey: Uint8Array;
  wsPort: number;
  httpPort: number;
  adminToken: string;
}

async function startLoopback(): Promise<LoopbackEnv> {
  const dir = freshTempDir();
  const audit = new AuditLog(join(dir, "audit.db"));
  const nonces = new NonceStore({ dbPath: join(dir, "nonces.db") });
  const sessions = new SessionStore();
  const lifecycle = new LifecycleManager();
  const router = new ResultRouter({ audit, sessions, lifecycle });
  const ackTimeout = new AckTimeoutManager({ timeoutMs: 5_000 });
  const registry = new EndpointRegistry({
    dbPath: join(dir, "endpoints.db"),
  });

  const tenantPrivKey = ed25519.utils.randomPrivateKey();
  const operatorHmacKey = new Uint8Array(32).fill(7); // fixed for test

  const dispatch = new DispatchOrchestrator({
    audit,
    nonces,
    sessions,
    lifecycle,
    tenantSigning: (tid) =>
      tid === "tenant-loopback"
        ? {
            signing_key_id: "tenant-loopback/key-v1",
            private_key: tenantPrivKey,
          }
        : null,
    endpointPublicKey: (eid) => registry.getPublicKey(eid),
  });

  const server = new RelayServer({
    audit,
    sessions,
    dispatch,
    router,
    ackTimeout,
    operatorHmacKey: (oid, tid) =>
      oid === "alice@local" && tid === "tenant-loopback"
        ? operatorHmacKey
        : null,
    endpointPublicKey: (eid) => registry.getPublicKey(eid),
  });

  const adminToken = "loopback-admin-" + Math.random().toString(36).slice(2);
  const httpHandle = await startEnrollmentHttp({
    port: 0, // random free port
    host: "127.0.0.1",
    registry,
    adminToken,
  });
  const wsHandle = await startWsBinding({
    port: 0,
    host: "127.0.0.1",
    server,
    sessions,
  });

  cleanupCallbacks.push(async () => {
    ackTimeout.cancelAll();
    await wsHandle.close();
    await httpHandle.close();
    audit.close();
    nonces.close();
    registry.close();
  });

  return {
    wsHandle,
    httpHandle,
    registry,
    audit,
    tenantPrivKey,
    operatorHmacKey,
    wsPort: wsHandle.port(),
    httpPort: httpHandle.port(),
    adminToken,
  };
}

async function enrollEndpoint(env: LoopbackEnv): Promise<{
  endpoint_id: string;
  privKey: Uint8Array;
  pubKey: Uint8Array;
}> {
  // 1. Admin issues bootstrap token
  const issueResp = await fetch(
    `http://127.0.0.1:${env.httpPort}/v1/admin/endpoint/enroll`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.adminToken}`,
      },
      body: JSON.stringify({ tenant_id: "tenant-loopback" }),
    },
  );
  expect(issueResp.status).toBe(200);
  const issued = (await issueResp.json()) as {
    bootstrap_token: string;
    endpoint_id: string;
  };

  // 2. Endpoint generates keypair + enrolls with bootstrap_token
  const privKey = ed25519.utils.randomPrivateKey();
  const pubKey = await ed25519.getPublicKeyAsync(privKey);
  const enrollResp = await fetch(
    `http://127.0.0.1:${env.httpPort}/v1/endpoint/enroll`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${issued.bootstrap_token}`,
      },
      body: JSON.stringify({
        public_key: bytesToBase64(pubKey),
        os: "linux",
        arch: "x86_64",
        agent_version: "v0.1-loopback",
      }),
    },
  );
  expect(enrollResp.status).toBe(200);

  return { endpoint_id: issued.endpoint_id, privKey, pubKey };
}

interface FakeEndpointConnection {
  ws: WebSocket;
  session_id: string;
  send: (frame: object) => Promise<void>;
  receive: () => Promise<{ type: string; [k: string]: unknown }>;
  close: () => void;
}

async function connectFakeEndpoint(args: {
  env: LoopbackEnv;
  endpoint_id: string;
  privKey: Uint8Array;
}): Promise<FakeEndpointConnection> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${args.env.wsPort}/v1/endpoint/connect`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const inbound: Array<{ type: string; [k: string]: unknown }> = [];
  const waiters: Array<(f: { type: string; [k: string]: unknown }) => void> =
    [];
  ws.on("message", (data) => {
    const text = data instanceof Buffer ? data.toString("utf-8") : String(data);
    const frame = JSON.parse(text) as { type: string; [k: string]: unknown };
    const w = waiters.shift();
    if (w !== undefined) w(frame);
    else inbound.push(frame);
  });

  const ts = new Date().toISOString();
  const proofPayload = {
    endpoint_id: args.endpoint_id,
    tenant_id: "tenant-loopback",
    ts,
  };
  const proofInput = signingInput(SIGN_CONTEXT.CONNECTION_PROOF, proofPayload);
  const proofDigest = sha256(proofInput);
  const proofSig = await ed25519.signAsync(proofDigest, args.privKey);
  const hello: EndpointHello = {
    type: "EndpointHello",
    endpoint_id: args.endpoint_id,
    tenant_id: "tenant-loopback",
    agent_version: "v0.1-loopback",
    agent_protocol_version: "v1",
    connection_proof: { ts, signature: bytesToBase64(proofSig) },
  };
  await new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(hello), (err) => (err ? reject(err) : resolve()));
  });

  // Wait for EndpointHelloAck
  const helloAck = await new Promise<{ type: string; session_id?: string }>(
    (resolve) => {
      const buffered = inbound.shift();
      if (buffered !== undefined) resolve(buffered);
      else waiters.push(resolve);
    },
  );
  expect(helloAck.type).toBe("EndpointHelloAck");
  if (helloAck.session_id === undefined) {
    throw new Error("EndpointHelloAck missing session_id");
  }
  const session_id = helloAck.session_id;

  return {
    ws,
    session_id,
    send: (frame) =>
      new Promise<void>((resolve, reject) => {
        ws.send(JSON.stringify(frame), (err) =>
          err ? reject(err) : resolve(),
        );
      }),
    receive: () =>
      new Promise((resolve) => {
        const buffered = inbound.shift();
        if (buffered !== undefined) resolve(buffered);
        else waiters.push(resolve);
      }),
    close: () => ws.close(),
  };
}

async function connectOperator(env: LoopbackEnv): Promise<{
  ws: WebSocket;
  send: (frame: object) => Promise<void>;
  receive: () => Promise<{ type: string; [k: string]: unknown }>;
  close: () => void;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${env.wsPort}/v1/operator`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  const inbound: Array<{ type: string; [k: string]: unknown }> = [];
  const waiters: Array<(f: { type: string; [k: string]: unknown }) => void> =
    [];
  ws.on("message", (data) => {
    const text = data instanceof Buffer ? data.toString("utf-8") : String(data);
    const frame = JSON.parse(text) as { type: string; [k: string]: unknown };
    const w = waiters.shift();
    if (w !== undefined) w(frame);
    else inbound.push(frame);
  });

  return {
    ws,
    send: (frame) =>
      new Promise<void>((resolve, reject) => {
        ws.send(JSON.stringify(frame), (err) =>
          err ? reject(err) : resolve(),
        );
      }),
    receive: () =>
      new Promise((resolve) => {
        const buffered = inbound.shift();
        if (buffered !== undefined) resolve(buffered);
        else waiters.push(resolve);
      }),
    close: () => ws.close(),
  };
}

// ---------------------------------------------------------------------------

describe("P1.4 Stage 1.0 loopback validation", () => {
  it("operator dispatches a tool via real WS over loopback; CommandAck + CommandResult flow back", async () => {
    const env = await startLoopback();

    // 1. Enroll an endpoint via HTTP
    const ep = await enrollEndpoint(env);

    // 2. Endpoint connects via WS
    const endpointConn = await connectFakeEndpoint({
      env,
      endpoint_id: ep.endpoint_id,
      privKey: ep.privKey,
    });

    // 3. Operator connects via WS
    const op = await connectOperator(env);

    // 4. Operator sends OperatorHello
    const hello: OperatorHello = {
      type: "OperatorHello",
      operator: {
        kind: "human",
        id: "alice@local",
        auth_proof: { kind: "hmac_signed_envelope", signature: "" },
      },
      tenant_id: "tenant-loopback",
      client_protocol_version: "v1",
    };
    const helloDigest = operatorHmac(
      hello as unknown as Record<string, unknown>,
      env.operatorHmacKey,
    );
    (hello.operator.auth_proof as { signature: string }).signature =
      bytesToBase64(helloDigest);
    await op.send(hello);

    const helloAck = await op.receive();
    expect(helloAck.type).toBe("OperatorHelloAck");

    // 5. Operator sends DispatchRequest
    const dispatchReq: DispatchRequest = {
      type: "DispatchRequest",
      request_id: "req-loopback-1",
      tool: "echo",
      params: { message: "hello loopback" },
      target_endpoint_id: ep.endpoint_id,
      tenant_id: "tenant-loopback",
      correlation_id: "corr-loopback-1",
      operator: {
        kind: "human",
        id: "alice@local",
        auth_proof: { kind: "hmac_signed_envelope", signature: "" },
      },
      options: {
        auto_confirm: false,
        stream_progress: true,
        deadline_ms: 30_000,
      },
    };
    const dispatchDigest = operatorHmac(
      dispatchReq as unknown as Record<string, unknown>,
      env.operatorHmacKey,
    );
    (dispatchReq.operator.auth_proof as { signature: string }).signature =
      bytesToBase64(dispatchDigest);
    await op.send(dispatchReq);

    // 6. Operator receives ChangeSetPreview
    const previewFrame = await op.receive();
    expect(previewFrame.type).toBe("ChangeSetPreview");
    const preview = previewFrame as unknown as ChangeSetPreview;

    // 7. Operator sends ConfirmRequest
    await op.send({
      type: "ConfirmRequest",
      request_id: "req-loopback-1",
      command_id: preview.command_id,
      preview_hash: preview.preview_hash,
      confirm: true,
    });

    // 8. Endpoint receives CommandEnvelope
    const envelopeFrame = await endpointConn.receive();
    expect(envelopeFrame.type).toBe("CommandEnvelope");
    const envelope = envelopeFrame as unknown as CommandEnvelope;
    expect(envelope.target_endpoint_id).toBe(ep.endpoint_id);
    expect(envelope.session_id).toBe(endpointConn.session_id);

    // 9. Endpoint sends CommandAck (no progress for this simple tool)
    await endpointConn.send({
      type: "CommandAck",
      command_id: envelope.command_id,
      endpoint_id: ep.endpoint_id,
      session_id: endpointConn.session_id,
      track: "data_provider",
      will_emit_progress: false,
      ts: new Date().toISOString(),
    });

    // 10. Operator receives ProgressEvent { lifecycle_state: "started" }
    const progressFrame = await op.receive();
    expect(progressFrame.type).toBe("ProgressEvent");
    expect(progressFrame.lifecycle_state).toBe("started");

    // 11. Endpoint sends CommandResult
    const result: CompletedCommandResult = {
      type: "CommandResult",
      command_id: envelope.command_id,
      endpoint_id: ep.endpoint_id,
      session_id: endpointConn.session_id,
      lifecycle_state: "completed",
      payload: { stdout: "hello loopback\n", stderr: "", exit_code: 0 },
      evidence_hash: "sha256:" + "a".repeat(64),
      sandbox_reset_state: {
        reset_at: new Date().toISOString(),
        golden_hash: "sha256:" + "b".repeat(64),
        verification_passed: true,
        verification_details: {
          fs_hash: "sha256:" + "c".repeat(64),
          fs_hash_baseline: "sha256:" + "c".repeat(64),
          fs_hash_match: true,
          open_fd_count: 3,
          open_fd_count_baseline: 3,
          vmm_api_state: "running",
          expected_vmm_api_state: "running",
          divergence_action: "none",
        },
      },
      ts: new Date().toISOString(),
    };
    await endpointConn.send(result);

    // 12. Operator receives ResultEvent
    const resultEvent = (await op.receive()) as {
      type: string;
      lifecycle_state: string;
      payload: { stdout: string };
    };
    expect(resultEvent.type).toBe("ResultEvent");
    expect(resultEvent.lifecycle_state).toBe("completed");
    expect(resultEvent.payload.stdout).toBe("hello loopback\n");

    // 13. Audit chain integrity
    const auditEntries = env.audit.getByCommandId(envelope.command_id);
    expect(auditEntries.length).toBeGreaterThanOrEqual(4);
    const channels = auditEntries.map((e) => e.channel_of_origin);
    expect(channels).toContain("operator");
    expect(channels).toContain("relay-internal");
    expect(channels).toContain("endpoint");

    // Cleanup connections (server cleanup via afterEach)
    op.close();
    endpointConn.close();
  }, 30_000);
});
