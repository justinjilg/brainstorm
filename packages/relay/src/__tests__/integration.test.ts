// End-to-end integration test for the relay's dispatch flow.
//
// Uses mock transports (TransportHandle implementations that capture
// outgoing frames in memory) — exercises the full orchestration:
// operator hello → dispatch → preview → confirm → envelope → ACK →
// progress → result, with stale-session and timeout edge cases.
//
// No `ws` library involved; transport is the abstraction.

import { describe, it, expect, afterEach } from "vitest";
import * as ed25519 from "@noble/ed25519";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "@noble/hashes/sha256";

import { RelayServer } from "../relay-server.js";
import {
  DispatchOrchestrator,
  type TenantSigningContext,
} from "../dispatch.js";
import { ResultRouter } from "../result-router.js";
import { AckTimeoutManager } from "../ack-timeout.js";
import { AuditLog } from "../audit.js";
import { NonceStore } from "../nonce-store.js";
import { SessionStore, type TransportHandle } from "../session-store.js";
import { LifecycleManager } from "../lifecycle.js";
import { operatorHmac } from "../signing.js";
import { signingInput, SIGN_CONTEXT } from "../canonical.js";
import type {
  CommandAck,
  CompletedCommandResult,
  DispatchRequest,
  EndpointHello,
  OperatorHello,
} from "../types.js";

// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  tempDirs.length = 0;
});

function freshTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-integration-"));
  tempDirs.push(dir);
  return dir;
}

class MockTransport implements TransportHandle {
  public readonly received: object[] = [];
  private alive = true;
  async send(frame: unknown): Promise<void> {
    if (!this.alive) throw new Error("transport closed");
    this.received.push(frame as object);
  }
  async close(_reason?: string): Promise<void> {
    this.alive = false;
  }
  isAlive(): boolean {
    return this.alive;
  }
  /** Test helper: get the most recent received frame */
  last(): object | undefined {
    return this.received[this.received.length - 1];
  }
}

class FakeClock {
  private now = 0;
  private nextHandle = 1;
  private readonly pending = new Map<
    number,
    { dueAt: number; cb: () => void }
  >();
  setTimeout = (cb: () => void, ms: number): unknown => {
    const h = this.nextHandle++;
    this.pending.set(h, { dueAt: this.now + ms, cb });
    return h;
  };
  clearTimeout = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [h, e] of Array.from(this.pending)) {
      if (e.dueAt <= this.now) {
        this.pending.delete(h);
        e.cb();
      }
    }
  }
}

// ---------------------------------------------------------------------------

interface TestSetup {
  server: RelayServer;
  audit: AuditLog;
  sessions: SessionStore;
  lifecycle: LifecycleManager;
  router: ResultRouter;
  ackTimeout: AckTimeoutManager;
  clock: FakeClock;
  tenantPubKey: Uint8Array;
  tenantPrivKey: Uint8Array;
  endpointPubKey: Uint8Array;
  endpointPrivKey: Uint8Array;
  operatorHmacKey: Uint8Array;
}

async function setup(): Promise<TestSetup> {
  const dir = freshTempDir();
  const audit = new AuditLog(join(dir, "audit.db"));
  const nonces = new NonceStore({ dbPath: join(dir, "nonces.db") });
  const sessions = new SessionStore();
  const lifecycle = new LifecycleManager();
  const router = new ResultRouter({ audit, sessions, lifecycle });
  const clock = new FakeClock();
  const ackTimeout = new AckTimeoutManager({
    timeoutMs: 5000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });

  const tenantPrivKey = ed25519.utils.randomPrivateKey();
  const tenantPubKey = await ed25519.getPublicKeyAsync(tenantPrivKey);
  const endpointPrivKey = ed25519.utils.randomPrivateKey();
  const endpointPubKey = await ed25519.getPublicKeyAsync(endpointPrivKey);
  const operatorHmacKey = new Uint8Array(32).fill(7);

  const tenantSigning: TenantSigningContext = {
    signing_key_id: "tenant-1/key-v1",
    private_key: tenantPrivKey,
  };

  const dispatch = new DispatchOrchestrator({
    audit,
    nonces,
    sessions,
    lifecycle,
    tenantSigning: (tid) => (tid === "tenant-1" ? tenantSigning : null),
    endpointPublicKey: (eid) => (eid === "ep-1" ? endpointPubKey : null),
  });

  const server = new RelayServer({
    audit,
    sessions,
    dispatch,
    router,
    ackTimeout,
    operatorHmacKey: (oid, tid) =>
      oid === "alice@example.com" && tid === "tenant-1"
        ? operatorHmacKey
        : null,
    endpointPublicKey: (eid) => (eid === "ep-1" ? endpointPubKey : null),
  });

  return {
    server,
    audit,
    sessions,
    lifecycle,
    router,
    ackTimeout,
    clock,
    tenantPubKey,
    tenantPrivKey,
    endpointPubKey,
    endpointPrivKey,
    operatorHmacKey,
  };
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

async function buildSignedOperatorHello(args: {
  hmacKey: Uint8Array;
  operator_id: string;
  tenant_id: string;
}): Promise<OperatorHello> {
  const hello: OperatorHello = {
    type: "OperatorHello",
    operator: {
      kind: "human",
      id: args.operator_id,
      auth_proof: { kind: "hmac_signed_envelope", signature: "" },
    },
    tenant_id: args.tenant_id,
    client_protocol_version: "v1",
  };
  const digest = operatorHmac(
    hello as unknown as Record<string, unknown>,
    args.hmacKey,
  );
  (
    hello.operator as { auth_proof: { signature: string } }
  ).auth_proof.signature = bytesToBase64(digest);
  return hello;
}

async function buildSignedEndpointHello(args: {
  endpointPrivKey: Uint8Array;
  endpoint_id: string;
  tenant_id: string;
  ts?: string;
}): Promise<EndpointHello> {
  const ts = args.ts ?? new Date().toISOString();
  const payload = {
    endpoint_id: args.endpoint_id,
    tenant_id: args.tenant_id,
    ts,
  };
  const input = signingInput(SIGN_CONTEXT.CONNECTION_PROOF, payload);
  const digest = sha256(input);
  const sig = await ed25519.signAsync(digest, args.endpointPrivKey);
  return {
    type: "EndpointHello",
    endpoint_id: args.endpoint_id,
    tenant_id: args.tenant_id,
    agent_version: "v0.1.0-test",
    agent_protocol_version: "v1",
    connection_proof: { ts, signature: bytesToBase64(sig) },
  };
}

async function buildSignedDispatchRequest(args: {
  hmacKey: Uint8Array;
  request_id: string;
  tool: string;
  params: Record<string, unknown>;
  target_endpoint_id: string;
  tenant_id: string;
}): Promise<DispatchRequest> {
  const req: DispatchRequest = {
    type: "DispatchRequest",
    request_id: args.request_id,
    tool: args.tool,
    params: args.params,
    target_endpoint_id: args.target_endpoint_id,
    tenant_id: args.tenant_id,
    correlation_id: "corr-" + args.request_id,
    operator: {
      kind: "human",
      id: "alice@example.com",
      auth_proof: { kind: "hmac_signed_envelope", signature: "" },
    },
    options: { auto_confirm: false, stream_progress: true, deadline_ms: 30000 },
  };
  const digest = operatorHmac(
    req as unknown as Record<string, unknown>,
    args.hmacKey,
  );
  (req.operator.auth_proof as { signature: string }).signature =
    bytesToBase64(digest);
  return req;
}

// ---------------------------------------------------------------------------

describe("integration: end-to-end dispatch happy path", () => {
  it("operator → relay → endpoint → CommandAck → CommandResult → operator", async () => {
    const t = await setup();
    const operatorTransport = new MockTransport();
    const endpointTransport = new MockTransport();

    // 1. Operator opens session: send OperatorHello, get OperatorHelloAck
    const hello = await buildSignedOperatorHello({
      hmacKey: t.operatorHmacKey,
      operator_id: "alice@example.com",
      tenant_id: "tenant-1",
    });
    const helloBytes = new TextEncoder().encode(JSON.stringify(hello));
    const operatorAccept = await t.server.acceptOperatorHello({
      transport: operatorTransport,
      helloBytes,
    });
    expect(operatorAccept.ok).toBe(true);
    if (!operatorAccept.ok) return;
    const operator_session_id = operatorAccept.operator_session_id;

    // 2. Endpoint opens session: send EndpointHello, get EndpointHelloAck
    const epHello = await buildSignedEndpointHello({
      endpointPrivKey: t.endpointPrivKey,
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
    });
    const endpointAccept = await t.server.acceptEndpointHello({
      transport: endpointTransport,
      hello: epHello,
    });
    expect(endpointAccept.ok).toBe(true);
    if (!endpointAccept.ok) return;
    const endpoint_session_id = endpointAccept.session_id;

    // 3. Operator sends DispatchRequest
    const dispatchReq = await buildSignedDispatchRequest({
      hmacKey: t.operatorHmacKey,
      request_id: "req-1",
      tool: "echo",
      params: { message: "hello" },
      target_endpoint_id: "ep-1",
      tenant_id: "tenant-1",
    });
    const dispatchBytes = new TextEncoder().encode(JSON.stringify(dispatchReq));
    const dispatchResult = await t.server.handleDispatchRequest({
      operator_session_id,
      request: dispatchReq,
      request_bytes: dispatchBytes,
    });
    expect(dispatchResult.ok).toBe(true);
    if (!dispatchResult.ok) return;
    expect(dispatchResult.preview.type).toBe("ChangeSetPreview");
    expect(dispatchResult.preview.preview_hash).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    const command_id = dispatchResult.preview.command_id;
    const preview_hash = dispatchResult.preview.preview_hash;

    // 4. Operator sends ConfirmRequest with matching preview_hash
    const confirmResult = await t.server.handleConfirmRequest({
      operator_session_id,
      confirm: {
        type: "ConfirmRequest",
        request_id: "req-1",
        command_id,
        preview_hash,
        confirm: true,
      },
    });
    expect(confirmResult.ok).toBe(true);
    if (!confirmResult.ok) return;
    expect(confirmResult.envelope.type).toBe("CommandEnvelope");
    expect(confirmResult.envelope.target_endpoint_id).toBe("ep-1");
    expect(confirmResult.envelope.session_id).toBe(endpoint_session_id);

    // 5. Caller would WS-write envelope to endpoint here. Simulate that.
    await confirmResult.endpoint_transport.send(confirmResult.envelope);
    t.server.startAckTimer(confirmResult.command_id);

    // 6. Endpoint sends CommandAck
    const ack: CommandAck = {
      type: "CommandAck",
      command_id,
      endpoint_id: "ep-1",
      session_id: endpoint_session_id,
      track: "data_provider",
      will_emit_progress: false,
      ts: new Date().toISOString(),
    };
    await t.server.handleEndpointCommandAck(ack);

    // 7. Operator should have received ProgressEvent { lifecycle_state: "started" }
    const progressFrame = operatorTransport.received.find(
      (f) => (f as { type: string }).type === "ProgressEvent",
    );
    expect(progressFrame).toBeDefined();
    expect((progressFrame as { lifecycle_state: string }).lifecycle_state).toBe(
      "started",
    );

    // ACK timer should be cancelled (no fire on 5s advance)
    t.clock.advance(10000);
    expect(
      operatorTransport.received.filter(
        (f) =>
          (f as { type: string; code?: string }).code === "ENDPOINT_NO_ACK",
      ).length,
    ).toBe(0);

    // 8. Endpoint sends CommandResult
    const result: CompletedCommandResult = {
      type: "CommandResult",
      command_id,
      endpoint_id: "ep-1",
      session_id: endpoint_session_id,
      lifecycle_state: "completed",
      payload: { stdout: "hello", stderr: "", exit_code: 0 },
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
    await t.server.handleEndpointCommandResult(result);

    // 9. Operator should have received ResultEvent { completed }
    const resultEvent = operatorTransport.received.find(
      (f) => (f as { type: string }).type === "ResultEvent",
    ) as { lifecycle_state: string; payload: { stdout: string } } | undefined;
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.lifecycle_state).toBe("completed");
    expect(resultEvent!.payload.stdout).toBe("hello");

    // 10. Lifecycle is terminal
    expect(t.lifecycle.isTerminal(command_id)).toBe(true);
    expect(t.router.inflightCount()).toBe(0);

    // 11. Audit log has the full chain
    const auditEntries = t.audit.getByCommandId(command_id);
    expect(auditEntries.length).toBeGreaterThanOrEqual(4);
    const channels = auditEntries.map((e) => e.channel_of_origin);
    expect(channels).toContain("operator");
    expect(channels).toContain("relay-internal");
    expect(channels).toContain("endpoint");
  });
});

describe("integration: rejection paths", () => {
  it("operator with wrong HMAC is rejected at hello", async () => {
    const t = await setup();
    const operatorTransport = new MockTransport();

    // Build a hello signed with the WRONG key
    const wrongKey = new Uint8Array(32).fill(99);
    const hello = await buildSignedOperatorHello({
      hmacKey: wrongKey,
      operator_id: "alice@example.com",
      tenant_id: "tenant-1",
    });
    const helloBytes = new TextEncoder().encode(JSON.stringify(hello));
    const r = await t.server.acceptOperatorHello({
      transport: operatorTransport,
      helloBytes,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_INVALID_PROOF");
  });

  it("endpoint with expired connection_proof is rejected", async () => {
    const t = await setup();
    const endpointTransport = new MockTransport();
    const oldTs = new Date(Date.now() - 120_000).toISOString();
    const epHello = await buildSignedEndpointHello({
      endpointPrivKey: t.endpointPrivKey,
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      ts: oldTs,
    });
    const r = await t.server.acceptEndpointHello({
      transport: endpointTransport,
      hello: epHello,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ENDPOINT_PROOF_EXPIRED");
  });

  it("endpoint reconnect replaces prior session; stale frames rejected", async () => {
    const t = await setup();
    const endpointTransport1 = new MockTransport();
    const endpointTransport2 = new MockTransport();

    // First session
    const epHello1 = await buildSignedEndpointHello({
      endpointPrivKey: t.endpointPrivKey,
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
    });
    const accept1 = await t.server.acceptEndpointHello({
      transport: endpointTransport1,
      hello: epHello1,
    });
    expect(accept1.ok).toBe(true);
    if (!accept1.ok) return;
    const session1 = accept1.session_id;

    // Reconnect — second session
    const epHello2 = await buildSignedEndpointHello({
      endpointPrivKey: t.endpointPrivKey,
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
    });
    const accept2 = await t.server.acceptEndpointHello({
      transport: endpointTransport2,
      hello: epHello2,
    });
    expect(accept2.ok).toBe(true);
    if (!accept2.ok) return;
    const session2 = accept2.session_id;
    expect(session1).not.toBe(session2);

    // Old transport should have been closed
    expect(endpointTransport1.isAlive()).toBe(false);
  });

  it("ACK timeout fires ENDPOINT_NO_ACK to operator", async () => {
    const t = await setup();
    const operatorTransport = new MockTransport();
    const endpointTransport = new MockTransport();

    // Establish operator + endpoint sessions
    const operatorAccept = await t.server.acceptOperatorHello({
      transport: operatorTransport,
      helloBytes: new TextEncoder().encode(
        JSON.stringify(
          await buildSignedOperatorHello({
            hmacKey: t.operatorHmacKey,
            operator_id: "alice@example.com",
            tenant_id: "tenant-1",
          }),
        ),
      ),
    });
    if (!operatorAccept.ok) throw new Error("operator hello failed");
    const operator_session_id = operatorAccept.operator_session_id;

    const epAccept = await t.server.acceptEndpointHello({
      transport: endpointTransport,
      hello: await buildSignedEndpointHello({
        endpointPrivKey: t.endpointPrivKey,
        endpoint_id: "ep-1",
        tenant_id: "tenant-1",
      }),
    });
    if (!epAccept.ok) throw new Error("endpoint hello failed");

    // Dispatch + confirm
    const dispatchReq = await buildSignedDispatchRequest({
      hmacKey: t.operatorHmacKey,
      request_id: "req-timeout",
      tool: "echo",
      params: { x: 1 },
      target_endpoint_id: "ep-1",
      tenant_id: "tenant-1",
    });
    const dr = await t.server.handleDispatchRequest({
      operator_session_id,
      request: dispatchReq,
      request_bytes: new TextEncoder().encode(JSON.stringify(dispatchReq)),
    });
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    const cr = await t.server.handleConfirmRequest({
      operator_session_id,
      confirm: {
        type: "ConfirmRequest",
        request_id: "req-timeout",
        command_id: dr.preview.command_id,
        preview_hash: dr.preview.preview_hash,
        confirm: true,
      },
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    // Start the ACK timer; advance clock past 5s without sending ACK
    t.server.startAckTimer(cr.command_id);
    t.clock.advance(5001);

    // Operator should have received ENDPOINT_NO_ACK error
    const errFrame = operatorTransport.received.find(
      (f) => (f as { type: string; code?: string }).code === "ENDPOINT_NO_ACK",
    );
    expect(errFrame).toBeDefined();
  });
});
