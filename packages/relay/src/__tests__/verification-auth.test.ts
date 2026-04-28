// Tests for verifyOperatorAuth — the unified dispatch over HMAC + CAF mTLS.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { verifyOperatorAuth } from "../verification.js";
import { CafVerifier } from "../caf-verifier.js";
import { operatorHmac } from "../signing.js";

let tmpDir: string;
let operatorCertPem: string;
let operatorCertFingerprintHex: string;

function bytesToBase64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "verify-auth-test-"));
  const keyPath = join(tmpDir, "ca.key");
  const certPath = join(tmpDir, "ca.crt");
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=operator-A",
      "-addext",
      "subjectAltName=URI:spiffe://brainstorm/operator/operator-A,URI:spiffe://brainstorm/tenant/tenant-1",
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  operatorCertPem = readFileSync(certPath, "utf-8");
  operatorCertFingerprintHex = createHash("sha256")
    .update(new X509Certificate(operatorCertPem).raw)
    .digest("hex");
});

afterAll(() => {
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
});

describe("verifyOperatorAuth — HMAC dispatch", () => {
  it("accepts a correctly-signed HMAC request", async () => {
    const key = new Uint8Array(32).fill(7);
    const req: Record<string, unknown> = {
      type: "OperatorHello",
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: { mode: "hmac", signature: "" },
      },
      tenant_id: "t-1",
    };
    const digest = operatorHmac(req, key);
    (req.operator as any).auth_proof.signature = bytesToBase64(digest);
    const r = await verifyOperatorAuth({ request: req, hmacKey: key });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mode).toBe("hmac");
  });

  it("rejects HMAC when no key is supplied", async () => {
    const req: Record<string, unknown> = {
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: { mode: "hmac", signature: "abc" },
      },
    };
    const r = await verifyOperatorAuth({ request: req, hmacKey: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_INVALID_PROOF");
  });
});

describe("verifyOperatorAuth — CAF mTLS dispatch", () => {
  it("accepts a CAF mTLS auth_proof when verifier + cert match", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [operatorCertFingerprintHex],
    });
    const req: Record<string, unknown> = {
      tenant_id: "tenant-1",
      operator: {
        kind: "human",
        id: "operator-A",
        auth_proof: {
          mode: "caf_mtls",
          cert_fingerprint: operatorCertFingerprintHex,
        },
      },
    };
    const r = await verifyOperatorAuth({
      request: req,
      cafVerifier: verifier,
      presentedCert: operatorCertPem,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mode).toBe("caf_mtls");
  });

  it("rejects CAF mTLS when cert identity does not match requested operator", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [operatorCertFingerprintHex],
    });
    const req: Record<string, unknown> = {
      tenant_id: "tenant-1",
      operator: {
        kind: "human",
        id: "operator-B",
        auth_proof: {
          mode: "caf_mtls",
          cert_fingerprint: operatorCertFingerprintHex,
        },
      },
    };
    const r = await verifyOperatorAuth({
      request: req,
      cafVerifier: verifier,
      presentedCert: operatorCertPem,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OPERATOR_IDENTITY_MISMATCH");
  });

  it("accepts CAF mTLS when cert identity matches requested operator", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [operatorCertFingerprintHex],
    });
    const req: Record<string, unknown> = {
      tenant_id: "tenant-1",
      operator: {
        kind: "human",
        id: "operator-A",
        auth_proof: {
          mode: "caf_mtls",
          cert_fingerprint: operatorCertFingerprintHex,
        },
      },
    };
    const r = await verifyOperatorAuth({
      request: req,
      cafVerifier: verifier,
      presentedCert: operatorCertPem,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mode).toBe("caf_mtls");
  });

  it("rejects CAF mTLS as not-supported when no verifier configured (preserves pre-flag behavior)", async () => {
    const req: Record<string, unknown> = {
      tenant_id: "tenant-1",
      operator: {
        kind: "human",
        id: "operator-A",
        auth_proof: {
          mode: "caf_mtls",
          cert_fingerprint: operatorCertFingerprintHex,
        },
      },
    };
    const r = await verifyOperatorAuth({ request: req });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_MODE_NOT_SUPPORTED");
  });

  it("rejects CAF mTLS as invalid when claimed fingerprint doesn't match TLS cert", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [operatorCertFingerprintHex],
    });
    const req: Record<string, unknown> = {
      tenant_id: "tenant-1",
      operator: {
        kind: "human",
        id: "operator-A",
        auth_proof: {
          mode: "caf_mtls",
          cert_fingerprint: "0".repeat(64), // wrong
        },
      },
    };
    const r = await verifyOperatorAuth({
      request: req,
      cafVerifier: verifier,
      presentedCert: operatorCertPem,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_INVALID_PROOF");
  });

  it("rejects JWT auth mode (still reserved for v1.0+)", async () => {
    const req: Record<string, unknown> = {
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: { mode: "jwt", token: "x" },
      },
    };
    const r = await verifyOperatorAuth({ request: req });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_MODE_NOT_SUPPORTED");
  });

  it("rejects unknown auth_proof.mode as malformed", async () => {
    const req: Record<string, unknown> = {
      operator: {
        kind: "human",
        id: "alice",
        auth_proof: { mode: "psk", value: "xyz" },
      },
    };
    const r = await verifyOperatorAuth({ request: req });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUTH_MALFORMED");
  });
});
