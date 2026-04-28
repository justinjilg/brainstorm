import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ed25519 from "@noble/ed25519";

import { EndpointRegistry, startEnrollmentHttp } from "../enrollment.js";

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
  const dir = mkdtempSync(join(tmpdir(), "enrollment-test-"));
  tempDirs.push(dir);
  return dir;
}

function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

describe("EndpointRegistry — token issuance", () => {
  it("issues a fresh bootstrap token with TTL", () => {
    const reg = new EndpointRegistry({
      dbPath: join(freshTempDir(), "endpoints.db"),
    });
    const r = reg.issueToken({ tenant_id: "tenant-1" });
    expect(r.bootstrap_token.length).toBeGreaterThan(20);
    expect(r.tenant_id).toBe("tenant-1");
    expect(r.endpoint_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(r.expires_at).getTime()).toBeGreaterThan(Date.now());
    reg.close();
  });

  it("issuing for an existing endpoint_id reuses it (re-enrollment)", () => {
    const reg = new EndpointRegistry({
      dbPath: join(freshTempDir(), "endpoints.db"),
    });
    const first = reg.issueToken({ tenant_id: "tenant-1" });
    const second = reg.issueToken({
      tenant_id: "tenant-1",
      endpoint_id: first.endpoint_id,
    });
    expect(second.endpoint_id).toBe(first.endpoint_id);
    expect(second.bootstrap_token).not.toBe(first.bootstrap_token);
    reg.close();
  });
});

describe("EndpointRegistry — enrollment", () => {
  it("happy path: token issued → enroll succeeds → public key retrievable", async () => {
    const reg = new EndpointRegistry({
      dbPath: join(freshTempDir(), "endpoints.db"),
    });
    const issued = reg.issueToken({ tenant_id: "tenant-1" });
    const priv = ed25519.utils.randomPrivateKey();
    const pub = await ed25519.getPublicKeyAsync(priv);
    const r = reg.enrollEndpoint({
      bootstrap_token: issued.bootstrap_token,
      public_key_b64: bytesToBase64(pub),
      os: "linux",
      arch: "amd64",
      agent_version: "v0.1.0",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.endpoint_id).toBe(issued.endpoint_id);
    const retrieved = reg.getPublicKey(issued.endpoint_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(32);
    expect(Array.from(retrieved!)).toEqual(Array.from(pub));
    reg.close();
  });

  it("rejects double-enrollment on same token (TOKEN_ALREADY_CONSUMED)", async () => {
    const reg = new EndpointRegistry({
      dbPath: join(freshTempDir(), "endpoints.db"),
    });
    const issued = reg.issueToken({ tenant_id: "tenant-1" });
    const priv = ed25519.utils.randomPrivateKey();
    const pub = await ed25519.getPublicKeyAsync(priv);

    const first = reg.enrollEndpoint({
      bootstrap_token: issued.bootstrap_token,
      public_key_b64: bytesToBase64(pub),
      os: "linux",
      arch: "amd64",
      agent_version: "v0.1.0",
    });
    expect(first.ok).toBe(true);

    const second = reg.enrollEndpoint({
      bootstrap_token: issued.bootstrap_token,
      public_key_b64: bytesToBase64(pub),
      os: "linux",
      arch: "amd64",
      agent_version: "v0.1.0",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("TOKEN_ALREADY_CONSUMED");
    reg.close();
  });

  it("rejects unknown bootstrap_token", () => {
    const reg = new EndpointRegistry({
      dbPath: join(freshTempDir(), "endpoints.db"),
    });
    const r = reg.enrollEndpoint({
      bootstrap_token: "totally-fake-token",
      public_key_b64: "AAAA",
      os: "linux",
      arch: "amd64",
      agent_version: "v0.1.0",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOKEN_NOT_FOUND");
    reg.close();
  });

  it("revoked endpoint returns null public key", async () => {
    const reg = new EndpointRegistry({
      dbPath: join(freshTempDir(), "endpoints.db"),
    });
    const issued = reg.issueToken({ tenant_id: "tenant-1" });
    const priv = ed25519.utils.randomPrivateKey();
    const pub = await ed25519.getPublicKeyAsync(priv);
    reg.enrollEndpoint({
      bootstrap_token: issued.bootstrap_token,
      public_key_b64: bytesToBase64(pub),
      os: "linux",
      arch: "amd64",
      agent_version: "v0.1.0",
    });
    expect(reg.getPublicKey(issued.endpoint_id)).not.toBeNull();
    reg.revokeEndpoint(issued.endpoint_id);
    expect(reg.getPublicKey(issued.endpoint_id)).toBeNull();
    reg.close();
  });

  it("re-enrollment after revocation succeeds with new key", async () => {
    const reg = new EndpointRegistry({
      dbPath: join(freshTempDir(), "endpoints.db"),
    });
    const issued1 = reg.issueToken({ tenant_id: "tenant-1" });
    const priv1 = ed25519.utils.randomPrivateKey();
    const pub1 = await ed25519.getPublicKeyAsync(priv1);
    reg.enrollEndpoint({
      bootstrap_token: issued1.bootstrap_token,
      public_key_b64: bytesToBase64(pub1),
      os: "linux",
      arch: "amd64",
      agent_version: "v0.1.0",
    });
    reg.revokeEndpoint(issued1.endpoint_id);

    // Re-enroll with new token + new key
    const issued2 = reg.issueToken({
      tenant_id: "tenant-1",
      endpoint_id: issued1.endpoint_id,
    });
    const priv2 = ed25519.utils.randomPrivateKey();
    const pub2 = await ed25519.getPublicKeyAsync(priv2);
    reg.enrollEndpoint({
      bootstrap_token: issued2.bootstrap_token,
      public_key_b64: bytesToBase64(pub2),
      os: "linux",
      arch: "amd64",
      agent_version: "v0.1.1",
    });
    const retrieved = reg.getPublicKey(issued1.endpoint_id);
    expect(retrieved).not.toBeNull();
    expect(Array.from(retrieved!)).toEqual(Array.from(pub2));
    reg.close();
  });
});

describe("HTTP /v1/health", () => {
  it("returns 200 + {ok:true,ts} without auth", async () => {
    const reg = new EndpointRegistry({ dbPath: ":memory:" });
    const handle = await startEnrollmentHttp({
      registry: reg,
      port: 0,
      adminToken: "test-admin",
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${handle.port()}/v1/health`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { ok: boolean; ts: string };
      expect(body.ok).toBe(true);
      expect(typeof body.ts).toBe("string");
      expect(new Date(body.ts).toString()).not.toBe("Invalid Date");
    } finally {
      await handle.close();
      reg.close();
    }
  });

  it("rejects oversized request body with 413 (closes #289)", async () => {
    const reg = new EndpointRegistry({ dbPath: ":memory:" });
    const handle = await startEnrollmentHttp({
      registry: reg,
      port: 0,
      adminToken: "test-admin",
    });
    try {
      // 65 KiB body — just past the 64 KiB cap.
      const oversize = "x".repeat(65 * 1024);
      const resp = await fetch(
        `http://127.0.0.1:${handle.port()}/v1/admin/endpoint/enroll`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-admin",
          },
          body: JSON.stringify({ tenant_id: oversize }),
        },
      );
      expect(resp.status).toBe(413);
      const body = (await resp.json()) as { code: string };
      expect(body.code).toBe("PAYLOAD_TOO_LARGE");
    } finally {
      await handle.close();
      reg.close();
    }
  });

  it("rejects POST /v1/health with 405", async () => {
    const reg = new EndpointRegistry({ dbPath: ":memory:" });
    const handle = await startEnrollmentHttp({
      registry: reg,
      port: 0,
      adminToken: "test-admin",
    });
    try {
      const resp = await fetch(`http://127.0.0.1:${handle.port()}/v1/health`, {
        method: "POST",
        body: "{}",
      });
      expect(resp.status).toBe(405);
    } finally {
      await handle.close();
      reg.close();
    }
  });
});
