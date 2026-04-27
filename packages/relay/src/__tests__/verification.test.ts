import { describe, it, expect } from "vitest";
import * as ed25519 from "@noble/ed25519";
import { verifyOperatorHmac, verifyConnectionProof } from "../verification.js";
import { operatorHmac } from "../signing.js";
import { SIGN_CONTEXT, signingInput } from "../canonical.js";
import { sha256 } from "@noble/hashes/sha256";

function buildRequestWithSignature(opts: {
  hmacKey: Uint8Array;
  message?: string;
}): Record<string, unknown> {
  const req: Record<string, unknown> = {
    type: "DispatchRequest",
    request_id: "req-1",
    tool: "echo",
    params: { message: opts.message ?? "hello" },
    target_endpoint_id: "ep-1",
    tenant_id: "tenant-1",
    correlation_id: "corr-1",
    operator: {
      kind: "human",
      id: "alice@example.com",
      auth_proof: { kind: "hmac_signed_envelope", signature: "" },
    },
    options: { auto_confirm: false, stream_progress: true, deadline_ms: 30000 },
  };
  // Compute HMAC over the request with signature=""; then set the signature
  const digest = operatorHmac(req, opts.hmacKey);
  const sigB64 = bytesToBase64(digest);
  (req.operator as any).auth_proof.signature = sigB64;
  return req;
}

function bytesToBase64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}

describe("verifyOperatorHmac", () => {
  it("accepts a correctly-signed request", () => {
    const key = new Uint8Array(32).fill(7);
    const req = buildRequestWithSignature({ hmacKey: key });
    const r = verifyOperatorHmac({ request: req, hmacKey: key });
    expect(r.ok).toBe(true);
  });

  it("rejects with AUTH_INVALID_PROOF when signature is wrong", () => {
    const key = new Uint8Array(32).fill(7);
    const req = buildRequestWithSignature({ hmacKey: key });
    // Tamper with params after signing
    (req as any).params.message = "modified";
    const r = verifyOperatorHmac({ request: req, hmacKey: key });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_INVALID_PROOF");
  });

  it("rejects with AUTH_INVALID_PROOF when key is wrong", () => {
    const key1 = new Uint8Array(32).fill(7);
    const key2 = new Uint8Array(32).fill(8);
    const req = buildRequestWithSignature({ hmacKey: key1 });
    const r = verifyOperatorHmac({ request: req, hmacKey: key2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_INVALID_PROOF");
  });

  it("rejects JWT auth mode in MVP", () => {
    const key = new Uint8Array(32).fill(7);
    const req: Record<string, unknown> = {
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: { kind: "jwt", token: "x" },
      },
    };
    const r = verifyOperatorHmac({ request: req, hmacKey: key });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_MODE_NOT_SUPPORTED");
  });

  it("rejects CAF mTLS auth mode in MVP", () => {
    const key = new Uint8Array(32).fill(7);
    const req: Record<string, unknown> = {
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: { kind: "caf_mtls", cert_fingerprint: "x" },
      },
    };
    const r = verifyOperatorHmac({ request: req, hmacKey: key });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_MODE_NOT_SUPPORTED");
  });

  it("rejects missing auth_proof as malformed", () => {
    const key = new Uint8Array(32).fill(7);
    const req: Record<string, unknown> = {
      operator: { kind: "human", id: "alice" },
    };
    const r = verifyOperatorHmac({ request: req, hmacKey: key });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_MALFORMED");
  });

  it("rejects malformed base64 signature", () => {
    const key = new Uint8Array(32).fill(7);
    const req: Record<string, unknown> = {
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: {
          kind: "hmac_signed_envelope",
          signature: "!!! not base64 !!!",
        },
      },
    };
    const r = verifyOperatorHmac({ request: req, hmacKey: key });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_MALFORMED");
  });

  it("rejects wrong-size key", () => {
    const req = buildRequestWithSignature({
      hmacKey: new Uint8Array(32).fill(7),
    });
    const r = verifyOperatorHmac({ request: req, hmacKey: new Uint8Array(16) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_MALFORMED");
  });
});

describe("verifyConnectionProof", () => {
  async function makeKeypair() {
    const priv = ed25519.utils.randomPrivateKey();
    const pub = await ed25519.getPublicKeyAsync(priv);
    return { priv, pub };
  }

  async function signProof(args: {
    endpoint_id: string;
    tenant_id: string;
    ts: string;
    privateKey: Uint8Array;
  }): Promise<string> {
    const payload = {
      endpoint_id: args.endpoint_id,
      tenant_id: args.tenant_id,
      ts: args.ts,
    };
    const input = signingInput(SIGN_CONTEXT.CONNECTION_PROOF, payload);
    const digest = sha256(input);
    const sig = await ed25519.signAsync(digest, args.privateKey);
    return bytesToBase64(sig);
  }

  it("accepts a correctly-signed proof within clock skew", async () => {
    const { priv, pub } = await makeKeypair();
    const ts = new Date().toISOString();
    const sig = await signProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      ts,
      privateKey: priv,
    });
    const r = await verifyConnectionProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      proof: { ts, signature: sig },
      endpointPublicKey: pub,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects with ENDPOINT_PROOF_INVALID under wrong public key", async () => {
    const { priv } = await makeKeypair();
    const { pub: otherPub } = await makeKeypair();
    const ts = new Date().toISOString();
    const sig = await signProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      ts,
      privateKey: priv,
    });
    const r = await verifyConnectionProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      proof: { ts, signature: sig },
      endpointPublicKey: otherPub,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ENDPOINT_PROOF_INVALID");
  });

  it("rejects with ENDPOINT_PROOF_EXPIRED for ts > 60s in the past", async () => {
    const { priv, pub } = await makeKeypair();
    const past = new Date(Date.now() - 61_000).toISOString();
    const sig = await signProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      ts: past,
      privateKey: priv,
    });
    const r = await verifyConnectionProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      proof: { ts: past, signature: sig },
      endpointPublicKey: pub,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ENDPOINT_PROOF_EXPIRED");
  });

  it("rejects with ENDPOINT_PROOF_FUTURE_DATED for ts > 60s in the future", async () => {
    const { priv, pub } = await makeKeypair();
    const future = new Date(Date.now() + 120_000).toISOString();
    const sig = await signProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      ts: future,
      privateKey: priv,
    });
    const r = await verifyConnectionProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      proof: { ts: future, signature: sig },
      endpointPublicKey: pub,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ENDPOINT_PROOF_FUTURE_DATED");
  });

  it("rejects when endpoint_id in proof differs from claimed (prefix domain matters)", async () => {
    // The signed bytes include endpoint_id; if relay verifies with a
    // different endpoint_id than was signed, signature fails.
    const { priv, pub } = await makeKeypair();
    const ts = new Date().toISOString();
    // Sign with ep-1
    const sig = await signProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      ts,
      privateKey: priv,
    });
    // Verify claiming ep-2 — signature must fail
    const r = await verifyConnectionProof({
      endpoint_id: "ep-2",
      tenant_id: "tenant-1",
      proof: { ts, signature: sig },
      endpointPublicKey: pub,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ENDPOINT_PROOF_INVALID");
  });

  it("rejects malformed base64 signature", async () => {
    const { pub } = await makeKeypair();
    const ts = new Date().toISOString();
    const r = await verifyConnectionProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      proof: { ts, signature: "!!! not valid base64 !!!" },
      endpointPublicKey: pub,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ENDPOINT_PROOF_MALFORMED");
  });

  it("rejects malformed ts", async () => {
    const { pub } = await makeKeypair();
    const r = await verifyConnectionProof({
      endpoint_id: "ep-1",
      tenant_id: "tenant-1",
      proof: { ts: "not-a-date", signature: "AAAAAA" },
      endpointPublicKey: pub,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ENDPOINT_PROOF_MALFORMED");
  });
});
