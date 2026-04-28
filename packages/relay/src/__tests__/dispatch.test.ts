import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ed25519 from "@noble/ed25519";

import {
  DispatchOrchestrator,
  computePreviewHash,
  type TenantSigningContext,
} from "../dispatch.js";
import { AuditLog } from "../audit.js";
import { NonceStore } from "../nonce-store.js";
import { SessionStore, type TransportHandle } from "../session-store.js";
import { LifecycleManager } from "../lifecycle.js";
import { verifyEnvelope } from "../signing.js";
import { SIGN_CONTEXT } from "../canonical.js";
import type { DispatchRequest } from "../types.js";

// ----- test fixtures ------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs.length = 0;
});

function freshTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeTransport(): TransportHandle {
  let alive = true;
  return {
    async send(_frame) {},
    async close() {
      alive = false;
    },
    isAlive() {
      return alive;
    },
  };
}

async function makeTenantCtx(): Promise<{
  ctx: TenantSigningContext;
  pub: Uint8Array;
}> {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = await ed25519.getPublicKeyAsync(priv);
  return {
    ctx: { signing_key_id: "tenant-1/key-v1", private_key: priv },
    pub,
  };
}

async function makeOrchestrator(args: {
  tenantCtx: TenantSigningContext;
  endpointPubKey?: Uint8Array;
  now?: () => Date;
}): Promise<{
  orch: DispatchOrchestrator;
  audit: AuditLog;
  sessions: SessionStore;
  lifecycle: LifecycleManager;
}> {
  const dir = freshTempDir("dispatch-test-");
  const audit = new AuditLog(join(dir, "audit.db"));
  const nonces = new NonceStore({ dbPath: join(dir, "nonces.db") });
  const sessions = new SessionStore();
  const lifecycle = new LifecycleManager();
  const orch = new DispatchOrchestrator({
    audit,
    nonces,
    sessions,
    lifecycle,
    tenantSigning: (tenant_id) =>
      tenant_id === "tenant-1" ? args.tenantCtx : null,
    endpointPublicKey: () => args.endpointPubKey ?? null,
    now: args.now,
  });
  return { orch, audit, sessions, lifecycle };
}

function makeDispatchRequest(
  overrides: Partial<DispatchRequest> = {},
): DispatchRequest {
  return {
    type: "DispatchRequest",
    request_id: "req-1",
    tool: "echo",
    params: { message: "hello" },
    target_endpoint_id: "ep-1",
    tenant_id: "tenant-1",
    correlation_id: "corr-1",
    operator: {
      kind: "human",
      id: "alice@example.com",
      auth_proof: { mode: "hmac", signature: "stub" },
    },
    options: {
      auto_confirm: false,
      stream_progress: true,
      deadline_ms: 30_000,
    },
    ...overrides,
  };
}

function registerEndpoint(
  sessions: SessionStore,
  opts: {
    session_id: string;
    endpoint_id: string;
    tenant_id?: string;
  },
) {
  sessions.registerEndpoint({
    session_id: opts.session_id,
    endpoint_id: opts.endpoint_id,
    tenant_id: opts.tenant_id ?? "tenant-1",
    opened_at: new Date().toISOString(),
    transport: fakeTransport(),
    inflight_command_ids: new Set(),
  });
}

// ----- tests ---------------------------------------------------------------

describe("DispatchOrchestrator.beginDispatch", () => {
  it("fails CORRELATION_ID_INVALID when correlation_id is empty", async () => {
    const { ctx } = await makeTenantCtx();
    const { orch, sessions } = await makeOrchestrator({ tenantCtx: ctx });
    registerEndpoint(sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    const request = makeDispatchRequest({ correlation_id: "" });
    const r = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1",
      request_bytes: new TextEncoder().encode(JSON.stringify(request)),
      request,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CORRELATION_ID_INVALID");
  });

  it("happy path: returns command_id + ChangeSetPreview with preview_hash", async () => {
    const { ctx } = await makeTenantCtx();
    const { orch, sessions, lifecycle } = await makeOrchestrator({
      tenantCtx: ctx,
    });
    registerEndpoint(sessions, { session_id: "s-1", endpoint_id: "ep-1" });

    const request = makeDispatchRequest();
    const r = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1",
      request_bytes: new TextEncoder().encode(JSON.stringify(request)),
      request,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.preview.type).toBe("ChangeSetPreview");
      expect(r.preview.preview_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(lifecycle.getState(r.command_id)).toBe("pending");
    }
  });

  it("fails AUTH_TENANT_MISMATCH when request.tenant_id != session tenant_id", async () => {
    const { ctx } = await makeTenantCtx();
    const { orch, sessions } = await makeOrchestrator({ tenantCtx: ctx });
    registerEndpoint(sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    const request = makeDispatchRequest({ tenant_id: "tenant-2" });
    const r = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1", // mismatch
      request_bytes: new TextEncoder().encode(JSON.stringify(request)),
      request,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_TENANT_MISMATCH");
  });

  it("fails RELAY_ENDPOINT_UNREACHABLE when no active session for target", async () => {
    const { ctx } = await makeTenantCtx();
    const { orch } = await makeOrchestrator({ tenantCtx: ctx });
    // No endpoint registered
    const request = makeDispatchRequest();
    const r = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1",
      request_bytes: new TextEncoder().encode(JSON.stringify(request)),
      request,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RELAY_ENDPOINT_UNREACHABLE");
  });

  it("fails AUTH_TENANT_MISMATCH when endpoint tenant differs from request", async () => {
    const { ctx } = await makeTenantCtx();
    const { orch, sessions } = await makeOrchestrator({ tenantCtx: ctx });
    // Endpoint registered under DIFFERENT tenant
    registerEndpoint(sessions, {
      session_id: "s-1",
      endpoint_id: "ep-1",
      tenant_id: "tenant-X",
    });
    const request = makeDispatchRequest();
    const r = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1",
      request_bytes: new TextEncoder().encode(JSON.stringify(request)),
      request,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_TENANT_MISMATCH");
  });

  it("audit log records operator-origin verbatim bytes", async () => {
    const { ctx } = await makeTenantCtx();
    const { orch, sessions, audit } = await makeOrchestrator({
      tenantCtx: ctx,
    });
    registerEndpoint(sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    const request = makeDispatchRequest();
    const requestBytes = new TextEncoder().encode(
      JSON.stringify(request) + "\n# trailing comment",
      // trailing bytes ensure the verbatim-bytes guarantee is real
    );
    const r = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1",
      request_bytes: requestBytes,
      request,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const entries = audit.getByCommandId(r.command_id);
      const operatorEntry = entries.find(
        (e) => e.channel_of_origin === "operator",
      );
      expect(operatorEntry).toBeDefined();
      const decoded = Buffer.from(operatorEntry!.payload_bytes_b64, "base64");
      expect(decoded.equals(Buffer.from(requestBytes))).toBe(true);
    }
  });
});

describe("DispatchOrchestrator.produceEnvelope", () => {
  it("happy path: signs envelope, transitions lifecycle, audits", async () => {
    const { ctx, pub } = await makeTenantCtx();
    const { orch, sessions, lifecycle, audit } = await makeOrchestrator({
      tenantCtx: ctx,
    });
    registerEndpoint(sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    const request = makeDispatchRequest();
    const begin = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1",
      request_bytes: new TextEncoder().encode(JSON.stringify(request)),
      request,
    });
    if (!begin.ok) throw new Error("begin failed: " + begin.error.code);

    const r = await orch.produceEnvelope({
      request,
      confirm: {
        type: "ConfirmRequest",
        request_id: request.request_id,
        command_id: begin.command_id,
        preview_hash: begin.preview.preview_hash,
        confirm: true,
      },
      command_id: begin.command_id,
      expected_preview_hash: begin.preview.preview_hash,
      target_session_id: "s-1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.type).toBe("CommandEnvelope");
      expect(r.envelope.target_endpoint_id).toBe("ep-1");
      expect(r.envelope.session_id).toBe("s-1");
      expect(r.envelope.signature_algo).toBe("ed25519-jcs-sha256-v1");
      // Verify with tenant pub key — signature should be valid
      const ok = await verifyEnvelope(
        SIGN_CONTEXT.COMMAND_ENVELOPE,
        r.envelope as unknown as Parameters<typeof verifyEnvelope>[1],
        pub,
      );
      expect(ok).toBe(true);
      // Lifecycle transitioned pending → dispatched
      expect(lifecycle.getState(begin.command_id)).toBe("dispatched");
      // Audit log has 3 entries: operator DispatchRequest, relay-internal ChangeSetPreview, relay-internal CommandEnvelope
      const entries = audit.getByCommandId(begin.command_id);
      expect(entries.length).toBe(3);
      expect(entries[0].channel_of_origin).toBe("operator");
      expect(entries[1].message_type).toBe("ChangeSetPreview");
      expect(entries[2].message_type).toBe("CommandEnvelope");
    }
  });

  it("fails RELAY_PREVIEW_HASH_MISMATCH if confirm preview_hash differs", async () => {
    const { ctx } = await makeTenantCtx();
    const { orch, sessions } = await makeOrchestrator({ tenantCtx: ctx });
    registerEndpoint(sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    const request = makeDispatchRequest();
    const begin = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1",
      request_bytes: new TextEncoder().encode(JSON.stringify(request)),
      request,
    });
    if (!begin.ok) throw new Error("begin failed");
    const r = await orch.produceEnvelope({
      request,
      confirm: {
        type: "ConfirmRequest",
        request_id: request.request_id,
        command_id: begin.command_id,
        preview_hash: "sha256:" + "f".repeat(64), // wrong
        confirm: true,
      },
      command_id: begin.command_id,
      expected_preview_hash: begin.preview.preview_hash,
      target_session_id: "s-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RELAY_PREVIEW_HASH_MISMATCH");
  });

  it("fails RELAY_OPERATOR_DECLINED on confirm: false", async () => {
    const { ctx } = await makeTenantCtx();
    const { orch, sessions } = await makeOrchestrator({ tenantCtx: ctx });
    registerEndpoint(sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    const request = makeDispatchRequest();
    const begin = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1",
      request_bytes: new TextEncoder().encode(JSON.stringify(request)),
      request,
    });
    if (!begin.ok) throw new Error("begin failed");
    const r = await orch.produceEnvelope({
      request,
      confirm: {
        type: "ConfirmRequest",
        request_id: request.request_id,
        command_id: begin.command_id,
        preview_hash: begin.preview.preview_hash,
        confirm: false,
      },
      command_id: begin.command_id,
      expected_preview_hash: begin.preview.preview_hash,
      target_session_id: "s-1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RELAY_OPERATOR_DECLINED");
  });

  it("envelope strips operator.auth_proof — relay vouched, endpoint trusts signature", async () => {
    const { ctx } = await makeTenantCtx();
    const { orch, sessions } = await makeOrchestrator({ tenantCtx: ctx });
    registerEndpoint(sessions, { session_id: "s-1", endpoint_id: "ep-1" });
    const request = makeDispatchRequest();
    const begin = await orch.beginDispatch({
      operator_session_id: "op-1",
      operator: request.operator,
      tenant_id: "tenant-1",
      request_bytes: new TextEncoder().encode(JSON.stringify(request)),
      request,
    });
    if (!begin.ok) throw new Error("begin failed");
    const r = await orch.produceEnvelope({
      request,
      confirm: {
        type: "ConfirmRequest",
        request_id: request.request_id,
        command_id: begin.command_id,
        preview_hash: begin.preview.preview_hash,
        confirm: true,
      },
      command_id: begin.command_id,
      expected_preview_hash: begin.preview.preview_hash,
      target_session_id: "s-1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.envelope.operator as any).auth_proof).toBeUndefined();
    }
  });
});

describe("computePreviewHash", () => {
  it("is deterministic for the same input", () => {
    const req = makeDispatchRequest();
    const h1 = computePreviewHash(req, "Some preview");
    const h2 = computePreviewHash(req, "Some preview");
    expect(h1).toBe(h2);
  });

  it("strips operator.auth_proof from canonicalization (auth_proof change → same hash)", () => {
    const r1 = makeDispatchRequest();
    const r2 = makeDispatchRequest();
    (r2.operator.auth_proof as any).signature = "different";
    const h1 = computePreviewHash(r1, "x");
    const h2 = computePreviewHash(r2, "x");
    expect(h1).toBe(h2);
  });

  it("changes when params change", () => {
    const r1 = makeDispatchRequest();
    const r2 = makeDispatchRequest({ params: { message: "different" } });
    const h1 = computePreviewHash(r1, "x");
    const h2 = computePreviewHash(r2, "x");
    expect(h1).not.toBe(h2);
  });

  it("changes when preview_summary changes (binds preview text)", () => {
    const req = makeDispatchRequest();
    const h1 = computePreviewHash(req, "preview A");
    const h2 = computePreviewHash(req, "preview B");
    expect(h1).not.toBe(h2);
  });
});
