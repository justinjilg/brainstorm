// CAF mTLS verifier tests.
//
// We need real X.509 certs to exercise the chain-validation paths. Node's
// `crypto` module doesn't ship a cert-builder, so we shell out to openssl
// once at test-suite setup to generate:
//   - a self-signed CA
//   - a leaf cert signed by the CA (the operator cert)
//   - a second self-signed CA (for "wrong CA" negative case)
//
// The certs live in a temp dir that's cleaned up after the suite. We use
// `spawnSync` (not `exec`) with explicit argv arrays — no shell interpretation,
// no injection risk; argv values are mkdtempSync paths + literal flags.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { CafVerifier } from "../caf-verifier.js";

interface CertBundle {
  caCertPem: string;
  caCertFingerprintHex: string;
  leafCertPem: string;
  leafCertFingerprintHex: string;
}

let tmpDir: string;
let primary: CertBundle;
let secondCa: CertBundle;

function sha256HexOfPem(pem: string): string {
  const cert = new X509Certificate(pem);
  return createHash("sha256").update(cert.raw).digest("hex");
}

function runOpenssl(args: string[]): void {
  const r = spawnSync("openssl", args, { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(
      `openssl ${args.join(" ")} failed (status=${r.status}): ${r.stderr}`,
    );
  }
}

function generateCa(
  dir: string,
  name: string,
): { keyPath: string; certPath: string; certPem: string; fpHex: string } {
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.crt`);
  runOpenssl([
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
    `/CN=${name}-CA`,
  ]);
  const certPem = readFileSync(certPath, "utf-8");
  return {
    keyPath,
    certPath,
    certPem,
    fpHex: sha256HexOfPem(certPem),
  };
}

function generateLeaf(
  dir: string,
  name: string,
  caKey: string,
  caCert: string,
): { certPem: string; fpHex: string } {
  const keyPath = join(dir, `${name}.key`);
  const csrPath = join(dir, `${name}.csr`);
  const certPath = join(dir, `${name}.crt`);
  runOpenssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    csrPath,
    "-subj",
    `/CN=${name}`,
  ]);
  runOpenssl([
    "x509",
    "-req",
    "-in",
    csrPath,
    "-CA",
    caCert,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    certPath,
    "-days",
    "1",
  ]);
  const certPem = readFileSync(certPath, "utf-8");
  return { certPem, fpHex: sha256HexOfPem(certPem) };
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "caf-verifier-test-"));

  // Primary CA + leaf
  const ca1 = generateCa(tmpDir, "primary");
  const leaf1 = generateLeaf(tmpDir, "operator", ca1.keyPath, ca1.certPath);
  primary = {
    caCertPem: ca1.certPem,
    caCertFingerprintHex: ca1.fpHex,
    leafCertPem: leaf1.certPem,
    leafCertFingerprintHex: leaf1.fpHex,
  };

  // Second CA (untrusted)
  const ca2 = generateCa(tmpDir, "second");
  const leaf2 = generateLeaf(tmpDir, "operator2", ca2.keyPath, ca2.certPath);
  secondCa = {
    caCertPem: ca2.certPem,
    caCertFingerprintHex: ca2.fpHex,
    leafCertPem: leaf2.certPem,
    leafCertFingerprintHex: leaf2.fpHex,
  };
});

afterAll(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("CafVerifier — happy path (cert + chain valid)", () => {
  it("accepts a self-signed CA cert when its fingerprint is in the trust list", async () => {
    // The simplest pinned-cert scenario: the leaf cert IS the trust anchor.
    // (Node's X509Certificate doesn't auto-walk a chain bundled in PEM
    // without explicit linkage; we test the case where the operator cert
    // and the trust anchor coincide.)
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [primary.caCertFingerprintHex],
    });
    const result = await verifier.verifyOperator(
      primary.caCertPem,
      primary.caCertFingerprintHex,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.trusted_ca_fingerprint).toBe(primary.caCertFingerprintHex);
      expect(result.cert_serial_hex).toBeDefined();
      expect(result.certifiedOperatorId).toBe("primary-CA");
    }
  });
});

describe("CafVerifier — fingerprint mismatch (claimed != computed)", () => {
  it("rejects when claimed fingerprint doesn't match the cert's actual SHA-256", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [primary.caCertFingerprintHex],
    });
    // Claim secondCa's fingerprint but present primary's leaf
    const result = await verifier.verifyOperator(
      primary.leafCertPem,
      secondCa.leafCertFingerprintHex,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not match/i);
  });

  it("rejects when claimed fingerprint is malformed (wrong length)", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [primary.caCertFingerprintHex],
    });
    const result = await verifier.verifyOperator(primary.leafCertPem, "abc123");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/64-char/i);
  });
});

describe("CafVerifier — bad CA (cert valid but CA not in trust list)", () => {
  it("rejects a leaf whose CA fingerprint is not configured", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [primary.caCertFingerprintHex],
    });
    const result = await verifier.verifyOperator(
      secondCa.caCertPem,
      secondCa.caCertFingerprintHex,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no issuer/i);
  });

  it("rejects when trust list is empty", async () => {
    const verifier = new CafVerifier({ trustedCaFingerprintsHex: [] });
    const result = await verifier.verifyOperator(
      primary.caCertPem,
      primary.caCertFingerprintHex,
    );
    expect(result.ok).toBe(false);
  });
});

describe("CafVerifier — revocation hook", () => {
  it("rejects when revocation callback returns true", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [primary.caCertFingerprintHex],
      revocationCheck: async (_serialHex) => true,
    });
    const result = await verifier.verifyOperator(
      primary.caCertPem,
      primary.caCertFingerprintHex,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/revoked/i);
  });

  it("fails closed when revocation callback throws", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [primary.caCertFingerprintHex],
      revocationCheck: async () => {
        throw new Error("BR offline");
      },
    });
    const result = await verifier.verifyOperator(
      primary.caCertPem,
      primary.caCertFingerprintHex,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/revocation check failed/i);
  });

  it("accepts when revocation callback returns false", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [primary.caCertFingerprintHex],
      revocationCheck: async () => false,
    });
    const result = await verifier.verifyOperator(
      primary.caCertPem,
      primary.caCertFingerprintHex,
    );
    expect(result.ok).toBe(true);
  });
});

describe("CafVerifier — fingerprint normalization", () => {
  it("accepts uppercase hex with colons (openssl-style)", async () => {
    const colonFp = primary.caCertFingerprintHex
      .toUpperCase()
      .match(/.{2}/g)!
      .join(":");
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [colonFp],
    });
    const result = await verifier.verifyOperator(
      primary.caCertPem,
      primary.caCertFingerprintHex,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts uppercase claimedFingerprint", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [primary.caCertFingerprintHex],
    });
    const result = await verifier.verifyOperator(
      primary.caCertPem,
      primary.caCertFingerprintHex.toUpperCase(),
    );
    expect(result.ok).toBe(true);
  });
});

describe("CafVerifier — malformed cert", () => {
  it("rejects garbage cert bytes with a clear reason", async () => {
    const verifier = new CafVerifier({
      trustedCaFingerprintsHex: [primary.caCertFingerprintHex],
    });
    const result = await verifier.verifyOperator(
      "this is not a cert",
      "a".repeat(64),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/parse/i);
  });
});
