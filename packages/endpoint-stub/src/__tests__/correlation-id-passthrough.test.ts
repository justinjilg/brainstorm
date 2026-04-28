// Test: correlation_id from CommandEnvelope flows into ToolExecutorContext.
//
// Per peer 12xnwqbb's design: when an endpoint receives a CommandEnvelope
// and makes outbound LLM calls back through BR (`/v1/chat/completions`,
// etc.), those calls must carry the relay's correlation_id so BR can join
// cross-product audit chains. The endpoint-stub is the seam: it surfaces
// correlation_id on ToolExecutorContext so executors can forward it.
//
// We exercise this end-to-end against a live relay loopback, dispatching
// with a known correlation_id and asserting the executor saw it.

import { describe, it, expect, afterEach } from "vitest";
import * as ed25519 from "@noble/ed25519";
import WebSocket from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AuditLog,
  NonceStore,
  SessionStore,
  LifecycleManager,
  ResultRouter,
  AckTimeoutManager,
  DispatchOrchestrator,
  RelayServer,
  startWsBinding,
  startEnrollmentHttp,
  EndpointRegistry,
  operatorHmac,
  type WsBindingHandle,
  type EnrollmentHttpHandle,
} from "@brainst0rm/relay";
import type {
  OperatorHello,
  DispatchRequest,
  ChangeSetPreview,
} from "@brainst0rm/relay";

import {
  EndpointStub,
  type ToolExecutor,
  type ToolExecutorContext,
} from "../index.js";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cb of cleanups.reverse()) {
    try {
      await cb();
    } catch {}
  }
  cleanups.length = 0;
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  tempDirs.length = 0;
});

function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "corr-id-"));
  tempDirs.push(d);
  return d;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return Buffer.from(s, "binary").toString("base64");
}

describe("endpoint-stub correlation_id passthrough", () => {
  it("forwards CommandEnvelope.correlation_id into ToolExecutorContext.correlation_id", async () => {
    const dir = fresh();
    const audit = new AuditLog(join(dir, "audit.db"));
    const nonces = new NonceStore({ dbPath: join(dir, "nonces.db") });
    const sessions = new SessionStore();
    const lifecycle = new LifecycleManager();
    const router = new ResultRouter({ audit, sessions, lifecycle });
    const ackTimeout = new AckTimeoutManager({ timeoutMs: 5_000 });
    const registry = new EndpointRegistry({
      dbPath: join(dir, "endpoints.db"),
    });

    const tenantPriv = ed25519.utils.randomPrivateKey();
    const tenantPub = await ed25519.getPublicKeyAsync(tenantPriv);
    const opKey = new Uint8Array(32).fill(7);

    const dispatch = new DispatchOrchestrator({
      audit,
      nonces,
      sessions,
      lifecycle,
      tenantSigning: (tid) =>
        tid === "tenant-corr"
          ? { signing_key_id: "tenant-corr/key-v1", private_key: tenantPriv }
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
        oid === "alice@local" && tid === "tenant-corr" ? opKey : null,
      endpointPublicKey: (eid) => registry.getPublicKey(eid),
    });

    const adminToken = "corr-admin";
    const httpH: EnrollmentHttpHandle = await startEnrollmentHttp({
      port: 0,
      host: "127.0.0.1",
      registry,
      adminToken,
    });
    const wsH: WsBindingHandle = await startWsBinding({
      port: 0,
      host: "127.0.0.1",
      server,
      sessions,
    });
    cleanups.push(async () => {
      ackTimeout.cancelAll();
      await wsH.close();
      await httpH.close();
      audit.close();
      nonces.close();
      registry.close();
    });

    // Issue bootstrap
    const enrollResp = await fetch(
      `http://127.0.0.1:${httpH.port()}/v1/admin/endpoint/enroll`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ tenant_id: "tenant-corr" }),
      },
    );
    const issued = (await enrollResp.json()) as {
      bootstrap_token: string;
      endpoint_id: string;
    };

    // Capture-executor: records what it receives
    const captured: ToolExecutorContext[] = [];
    const captureExecutor: ToolExecutor = async (ctx) => {
      captured.push({ ...ctx });
      return {
        exit_code: 0,
        stdout: JSON.stringify({ saw_corr_id: ctx.correlation_id }),
        stderr: "",
      };
    };

    const stub = new EndpointStub({
      relayUrl: `ws://127.0.0.1:${wsH.port()}`,
      tenantId: "tenant-corr",
      identityPath: join(dir, `endpoint-${issued.endpoint_id}.json`),
      endpointId: issued.endpoint_id,
      tenantPublicKey: tenantPub,
      executor: captureExecutor,
      logger: { info: () => {}, error: () => {} },
    });
    const pubB64 = await stub.publicKeyB64();
    await fetch(`http://127.0.0.1:${httpH.port()}/v1/endpoint/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${issued.bootstrap_token}`,
      },
      body: JSON.stringify({
        public_key: pubB64,
        os: "linux",
        arch: "x86_64",
        agent_version: "endpoint-stub-corr-test",
      }),
    });
    await stub.connect();
    const runP = stub.run();
    runP.catch(() => {});
    cleanups.push(async () => {
      await stub.close();
    });

    // Operator dispatch with a known correlation_id
    const opWs = new WebSocket(`ws://127.0.0.1:${wsH.port()}/v1/operator`);
    await new Promise<void>((resolve, reject) => {
      opWs.once("open", () => resolve());
      opWs.once("error", reject);
    });
    const inbound: Array<{ type: string; [k: string]: unknown }> = [];
    const waiters: Array<(f: { type: string; [k: string]: unknown }) => void> =
      [];
    opWs.on("message", (data) => {
      const text =
        data instanceof Buffer ? data.toString("utf-8") : String(data);
      const f = JSON.parse(text) as { type: string; [k: string]: unknown };
      const w = waiters.shift();
      if (w !== undefined) w(f);
      else inbound.push(f);
    });
    const send = (frame: object): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        opWs.send(JSON.stringify(frame), (err) =>
          err ? reject(err) : resolve(),
        );
      });
    const recv = (): Promise<{ type: string; [k: string]: unknown }> =>
      new Promise((resolve) => {
        const buffered = inbound.shift();
        if (buffered !== undefined) resolve(buffered);
        else waiters.push(resolve);
      });

    const hello: OperatorHello = {
      type: "OperatorHello",
      operator: {
        kind: "human",
        id: "alice@local",
        auth_proof: { mode: "hmac", signature: "" },
      },
      tenant_id: "tenant-corr",
      client_protocol_version: "v1",
    };
    const helloSig = operatorHmac(
      hello as unknown as Record<string, unknown>,
      opKey,
    );
    (hello.operator.auth_proof as { signature: string }).signature =
      bytesToBase64(helloSig);
    await send(hello);
    const ack = await recv();
    expect(ack.type).toBe("OperatorHelloAck");

    const KNOWN_CORR_ID = "corr-cross-product-audit-trace-12345";
    const dispatchReq: DispatchRequest = {
      type: "DispatchRequest",
      request_id: "req-1",
      tool: "echo",
      params: { hello: "world" },
      target_endpoint_id: issued.endpoint_id,
      tenant_id: "tenant-corr",
      correlation_id: KNOWN_CORR_ID,
      operator: {
        kind: "human",
        id: "alice@local",
        auth_proof: { mode: "hmac", signature: "" },
      },
      options: {
        auto_confirm: false,
        stream_progress: true,
        deadline_ms: 30_000,
      },
    };
    const drSig = operatorHmac(
      dispatchReq as unknown as Record<string, unknown>,
      opKey,
    );
    (dispatchReq.operator.auth_proof as { signature: string }).signature =
      bytesToBase64(drSig);
    await send(dispatchReq);
    const previewFrame = await recv();
    expect(previewFrame.type).toBe("ChangeSetPreview");
    const preview = previewFrame as unknown as ChangeSetPreview;

    await send({
      type: "ConfirmRequest",
      request_id: "req-1",
      command_id: preview.command_id,
      preview_hash: preview.preview_hash,
      confirm: true,
    });

    let terminal: { type: string; [k: string]: unknown };
    while (true) {
      terminal = await recv();
      if (terminal.type === "ResultEvent" || terminal.type === "ErrorEvent")
        break;
    }
    expect(terminal.type).toBe("ResultEvent");
    expect(terminal.lifecycle_state).toBe("completed");

    // The executor must have seen the correlation_id verbatim
    expect(captured.length).toBe(1);
    expect(captured[0].correlation_id).toBe(KNOWN_CORR_ID);
    // And the result echoes it (independent confirmation through the wire)
    const payload = terminal.payload as { stdout: string };
    const stdoutObj = JSON.parse(payload.stdout);
    expect(stdoutObj.saw_corr_id).toBe(KNOWN_CORR_ID);

    opWs.close();
  }, 30_000);
});
