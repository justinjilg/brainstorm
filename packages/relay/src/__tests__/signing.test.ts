import { describe, it, expect } from "vitest";
import * as ed25519 from "@noble/ed25519";
import {
  digestForSigning,
  signEnvelope,
  verifyEnvelope,
  operatorHmac,
  operatorHmacDispatchRequest,
  constantTimeEqual,
  SIGNATURE_ALGO,
} from "../signing.js";
import { SIGN_CONTEXT } from "../canonical.js";

describe("Ed25519 envelope signing", () => {
  async function makeKeypair() {
    const priv = ed25519.utils.randomPrivateKey();
    const pub = await ed25519.getPublicKeyAsync(priv);
    return { priv, pub };
  }

  it("signs an envelope and verifies with the matching public key", async () => {
    const { priv, pub } = await makeKeypair();
    const envelope = {
      type: "CommandEnvelope",
      command_id: "abc",
      signature: "",
    };
    const signed = await signEnvelope(
      SIGN_CONTEXT.COMMAND_ENVELOPE,
      envelope,
      priv,
    );
    expect(signed.signature_algo).toBe(SIGNATURE_ALGO);
    expect(signed.signature.length).toBeGreaterThan(0);
    const ok = await verifyEnvelope(SIGN_CONTEXT.COMMAND_ENVELOPE, signed, pub);
    expect(ok).toBe(true);
  });

  it("rejects when verified against the wrong public key", async () => {
    const { priv } = await makeKeypair();
    const { pub: otherPub } = await makeKeypair();
    const envelope = {
      type: "CommandEnvelope",
      command_id: "abc",
      signature: "",
    };
    const signed = await signEnvelope(
      SIGN_CONTEXT.COMMAND_ENVELOPE,
      envelope,
      priv,
    );
    const ok = await verifyEnvelope(
      SIGN_CONTEXT.COMMAND_ENVELOPE,
      signed,
      otherPub,
    );
    expect(ok).toBe(false);
  });

  it("rejects when verified with the wrong signing context (domain separation)", async () => {
    const { priv, pub } = await makeKeypair();
    const envelope = {
      type: "ConnectionProof",
      endpoint_id: "abc",
      signature: "",
    };
    const signed = await signEnvelope(
      SIGN_CONTEXT.CONNECTION_PROOF,
      envelope,
      priv,
    );
    // Verify with COMMAND_ENVELOPE context — should fail because prefix differs
    const ok = await verifyEnvelope(SIGN_CONTEXT.COMMAND_ENVELOPE, signed, pub);
    expect(ok).toBe(false);
  });

  it("rejects when signature_algo doesn't match", async () => {
    const { priv, pub } = await makeKeypair();
    const envelope = { type: "X", signature: "" };
    const signed = await signEnvelope(
      SIGN_CONTEXT.COMMAND_ENVELOPE,
      envelope,
      priv,
    );
    const tampered = {
      ...signed,
      signature_algo: "rsa-pkcs1-v1.5-sha256" as any,
    };
    const ok = await verifyEnvelope(
      SIGN_CONTEXT.COMMAND_ENVELOPE,
      tampered,
      pub,
    );
    expect(ok).toBe(false);
  });

  it("rejects when the envelope body has been tampered with", async () => {
    const { priv, pub } = await makeKeypair();
    const envelope = { type: "X", command_id: "abc", signature: "" };
    const signed = await signEnvelope(
      SIGN_CONTEXT.COMMAND_ENVELOPE,
      envelope,
      priv,
    );
    const tampered = { ...signed, command_id: "different" };
    const ok = await verifyEnvelope(
      SIGN_CONTEXT.COMMAND_ENVELOPE,
      tampered,
      pub,
    );
    expect(ok).toBe(false);
  });

  it("digestForSigning throws if signature is not empty string", () => {
    expect(() =>
      digestForSigning(SIGN_CONTEXT.COMMAND_ENVELOPE, {
        signature: "alreadyset",
      } as any),
    ).toThrow();
  });
});

describe("operator HMAC", () => {
  it("produces stable output for the same input + key", () => {
    const key = new Uint8Array(32).fill(7);
    const req = {
      type: "DispatchRequest",
      request_id: "r1",
      auth_proof: { kind: "hmac_signed_envelope", signature: "" },
    };
    const a = operatorHmac(req, key);
    const b = operatorHmac(req, key);
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it("produces different output under different keys", () => {
    const k1 = new Uint8Array(32).fill(1);
    const k2 = new Uint8Array(32).fill(2);
    const req = { type: "DispatchRequest", request_id: "r1" };
    const a = operatorHmac(req, k1);
    const b = operatorHmac(req, k2);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("constantTimeEqual returns false for length mismatch", () => {
    expect(
      constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])),
    ).toBe(false);
  });

  it("constantTimeEqual returns true for identical contents", () => {
    expect(
      constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])),
    ).toBe(true);
  });

  it("operatorHmac throws on non-32-byte key", () => {
    expect(() => operatorHmac({ a: 1 }, new Uint8Array(16))).toThrow(
      /must be 32 bytes/,
    );
  });
});

describe("operatorHmacDispatchRequest", () => {
  function makeRequest(): Record<string, unknown> {
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
        id: "user@example.com",
        auth_proof: {
          kind: "hmac_signed_envelope",
          signature: "the-real-signature-goes-here",
        },
      },
      options: {
        auto_confirm: false,
        stream_progress: true,
        deadline_ms: 30000,
      },
    };
  }

  it("does not mutate caller's request object", () => {
    const key = new Uint8Array(32).fill(7);
    const req = makeRequest();
    const before = JSON.stringify(req);
    operatorHmacDispatchRequest(req, key);
    const after = JSON.stringify(req);
    expect(after).toBe(before);
  });

  it("HMAC over request with auth_proof.signature='' is the same regardless of original signature value", () => {
    const key = new Uint8Array(32).fill(7);
    const r1 = makeRequest();
    const r2 = makeRequest();
    (r2 as any).operator.auth_proof.signature = "totally-different-value";
    const h1 = operatorHmacDispatchRequest(r1, key);
    const h2 = operatorHmacDispatchRequest(r2, key);
    expect(constantTimeEqual(h1, h2)).toBe(true);
  });

  it("HMAC differs when other request fields differ", () => {
    const key = new Uint8Array(32).fill(7);
    const r1 = makeRequest();
    const r2 = makeRequest();
    (r2 as any).params.message = "different";
    const h1 = operatorHmacDispatchRequest(r1, key);
    const h2 = operatorHmacDispatchRequest(r2, key);
    expect(constantTimeEqual(h1, h2)).toBe(false);
  });

  it("rejects non-hmac auth_proof.kind", () => {
    const key = new Uint8Array(32).fill(7);
    const req = makeRequest();
    (req as any).operator.auth_proof = { kind: "jwt", token: "x" };
    expect(() => operatorHmacDispatchRequest(req, key)).toThrow(
      /must be "hmac_signed_envelope"/,
    );
  });

  it("rejects missing operator.auth_proof", () => {
    const key = new Uint8Array(32).fill(7);
    const req = makeRequest();
    delete (req as any).operator.auth_proof;
    expect(() => operatorHmacDispatchRequest(req, key)).toThrow(
      /auth_proof missing/,
    );
  });

  it("rejects wrong-size key", () => {
    const req = makeRequest();
    expect(() => operatorHmacDispatchRequest(req, new Uint8Array(16))).toThrow(
      /must be 32 bytes/,
    );
  });
});
