// CAF mTLS operator verifier — implements protocol-v1 §3.4 D27 caf_mtls
// auth_proof variant. v0.1.0 wire protocol shipped FROZEN with the type
// reserved for v1.0+; this module flips the runtime path from
// AUTH_MODE_NOT_SUPPORTED to verified.
//
// Verification flow (locked with peer 12xnwqbb):
//   1. Operator presents X.509 cert at TLS layer (mTLS handshake; the
//      WS upgrade context surfaces it via Node `req.socket.getPeerCertificate(true)`).
//   2. Relay extracts the TLS-presented cert (DER bytes or PEM).
//   3. Relay computes SHA-256 fingerprint of cert DER bytes.
//   4. Relay compares to `auth_proof.cert_fingerprint` from WS payload.
//      Match = the WS payload is bound to the TLS-presented cert.
//   5. Relay validates the cert chain: the cert's issuer (or a parent in
//      the chain) must match one of the configured trusted CA fingerprints
//      (e.g. BR's CA: 847e06d1902a84c9c6029570f3da8cb7a2d0618219c12b97b561cf8243773321).
//   6. Optional: revocation check — relay calls
//      `BR /v1/agent/auth/cert?serial=...` with a 5min cache. v1 may skip
//      this and rely on cert TTL = 5min instead.
//
// Honesty: this verifier does NOT itself perform the TLS handshake. It
// expects the cert to have been extracted upstream and passed in. The
// chain-validation here is a fingerprint-based check (parent-fingerprint
// in trusted set) not a full PKI walk — adequate for the BR CA pinning
// use-case but not a replacement for full RFC 5280 path validation.
//
// Forward direction: when v1.0 adds full PKI, this module is the seam to
// extend. The public API (verifyOperator) is stable.

import { createHash, X509Certificate } from "node:crypto";

// ---------------------------------------------------------------------------

export interface CafVerifierOptions {
  /**
   * Hex-encoded SHA-256 fingerprints of CAs the relay trusts to issue
   * operator certs. Matched against the operator cert's issuer cert
   * fingerprint. At least one match is required for chain-validation to
   * succeed.
   */
  trustedCaFingerprintsHex: string[];
  /**
   * Optional revocation check. Receives the cert serial number (hex)
   * and resolves to `true` if the cert is revoked. If undefined, no
   * revocation check is performed (relay relies on cert TTL).
   *
   * The implementation is expected to call BR's
   * `/v1/agent/auth/cert?serial=...` endpoint; this verifier doesn't
   * make the network call directly so it stays test-pure.
   */
  revocationCheck?: (serialHex: string) => Promise<boolean>;
  /** Logger for non-fatal diagnostics. */
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
}

export type CafVerifyResult =
  | {
      ok: true;
      /** Operator identity certified by the leaf cert. */
      certifiedOperatorId: string;
      /** Tenant identity certified by SAN URI, when the cert exposes one. */
      certifiedTenantId?: string;
      /** The matched CA fingerprint (lowercase hex). */
      trusted_ca_fingerprint: string;
      /** The operator cert serial (hex, lowercase). */
      cert_serial_hex: string;
    }
  | { ok: false; reason: string };

/**
 * Verify a CAF mTLS operator presentation.
 *
 * Inputs:
 *  - presentedCert: the TLS-layer cert as PEM string OR DER Buffer. This
 *    is what the operator's client actually sent during mTLS handshake.
 *  - claimedFingerprint: the `cert_fingerprint` field from the operator's
 *    auth_proof (hex, lowercased internally for comparison).
 *
 * Returns ok=true if:
 *  - presentedCert parses as X.509
 *  - SHA-256(DER(presentedCert)) hex equals lowercased claimedFingerprint
 *  - cert's issuer chain includes a fingerprint in trustedCaFingerprintsHex
 *    (we walk the cert's `issuerCertificate` chain via Node's X509Certificate
 *    `verify()`/`issuer` traversal — bounded depth for safety)
 *  - revocationCheck (if provided) returns false
 */
export class CafVerifier {
  private readonly opts: CafVerifierOptions;
  private readonly trustedCasNormalized: Set<string>;
  private readonly log: {
    info: (m: string) => void;
    error: (m: string) => void;
  };

  constructor(opts: CafVerifierOptions) {
    this.opts = opts;
    this.trustedCasNormalized = new Set(
      opts.trustedCaFingerprintsHex.map((s) => normalizeFingerprint(s)),
    );
    this.log = opts.logger ?? {
      info: (_m: string) => {},
      error: (_m: string) => {},
    };
    if (this.trustedCasNormalized.size === 0) {
      // Honest: an empty trust list means no operator can succeed.
      // Caller should configure at least one CA fingerprint.
      this.log.error(
        "CafVerifier constructed with empty trustedCaFingerprintsHex; all verifications will fail",
      );
    }
  }

  async verifyOperator(
    presentedCert: string | Buffer | Uint8Array,
    claimedFingerprint: string,
  ): Promise<CafVerifyResult> {
    if (claimedFingerprint === undefined || claimedFingerprint === null) {
      return { ok: false, reason: "claimedFingerprint missing" };
    }
    const claimedNormalized = normalizeFingerprint(claimedFingerprint);
    if (claimedNormalized.length !== 64) {
      return {
        ok: false,
        reason: `claimedFingerprint must be 64-char hex SHA-256; got ${claimedNormalized.length} chars`,
      };
    }

    // Parse cert
    let cert: X509Certificate;
    try {
      cert = parseX509(presentedCert);
    } catch (e) {
      return {
        ok: false,
        reason: `could not parse presented cert: ${(e as Error).message}`,
      };
    }

    // Compute SHA-256 of DER bytes
    const derBytes = cert.raw;
    const computedFp = sha256Hex(derBytes);
    if (!constantTimeHexEqual(computedFp, claimedNormalized)) {
      return {
        ok: false,
        reason:
          "claimed cert_fingerprint does not match TLS-presented cert SHA-256",
      };
    }

    // Walk issuer chain — Node's X509Certificate exposes `issuerCertificate`
    // when the chain is bundled. For the BR-CA pinning use-case we expect
    // the issuer to be present in the same chain bundle.
    const chainResult = this.validateChain(cert);
    if (!chainResult.ok) {
      return { ok: false, reason: chainResult.reason };
    }

    // Optional revocation check via injected callback
    const serialHex = (cert.serialNumber || "").toLowerCase();
    if (this.opts.revocationCheck !== undefined) {
      try {
        const revoked = await this.opts.revocationCheck(serialHex);
        if (revoked) {
          return { ok: false, reason: `cert serial ${serialHex} is revoked` };
        }
      } catch (e) {
        // Revocation-service failure: fail-closed. Operators with
        // legitimate certs will see transient failures during BR outages.
        // Trade-off: fail-open would let revoked certs through during
        // BR outages, which is worse.
        return {
          ok: false,
          reason: `revocation check failed: ${(e as Error).message}`,
        };
      }
    }

    const identity = extractCertifiedIdentity(cert);
    if (!identity.ok) {
      return { ok: false, reason: identity.reason };
    }
    if (identity.certifiedTenantId === undefined) {
      this.log.info(
        `CAF cert serial ${serialHex} has no tenant SAN binding; accepting JSON tenant claim`,
      );
    }

    return {
      ok: true,
      certifiedOperatorId: identity.certifiedOperatorId,
      ...(identity.certifiedTenantId !== undefined
        ? { certifiedTenantId: identity.certifiedTenantId }
        : {}),
      trusted_ca_fingerprint: chainResult.matched_ca,
      cert_serial_hex: serialHex,
    };
  }

  /**
   * Walk the issuer chain looking for a CA whose SHA-256 fingerprint
   * matches one in `trustedCaFingerprintsHex`. Bounded depth = 8 to
   * defend against pathological chains.
   */
  private validateChain(
    leaf: X509Certificate,
  ): { ok: true; matched_ca: string } | { ok: false; reason: string } {
    if (this.trustedCasNormalized.size === 0) {
      return { ok: false, reason: "no trusted CA fingerprints configured" };
    }

    // The leaf cert itself counts: a trusted CA fingerprint may directly
    // pin a self-signed operator cert (used in tightly-scoped deployments
    // where a single CA cert acts as both root and identity).
    const leafFp = sha256Hex(leaf.raw);
    if (this.trustedCasNormalized.has(leafFp)) {
      return { ok: true, matched_ca: leafFp };
    }

    let current: X509Certificate | undefined = leaf.issuerCertificate;
    let depth = 0;
    const MAX_DEPTH = 8;
    while (current !== undefined && depth < MAX_DEPTH) {
      const fp = sha256Hex(current.raw);
      if (this.trustedCasNormalized.has(fp)) {
        return { ok: true, matched_ca: fp };
      }
      // Avoid infinite loop on self-referential issuerCertificate (root)
      if (current.issuerCertificate === current) break;
      current = current.issuerCertificate;
      depth += 1;
    }
    return {
      ok: false,
      reason: "no issuer in cert chain matched a trusted CA fingerprint",
    };
  }
}

// ---------------------------------------------------------------------------

function parseX509(input: string | Buffer | Uint8Array): X509Certificate {
  if (typeof input === "string") {
    return new X509Certificate(input);
  }
  if (input instanceof Uint8Array && !Buffer.isBuffer(input)) {
    return new X509Certificate(Buffer.from(input));
  }
  return new X509Certificate(input as Buffer);
}

function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeFingerprint(fp: string): string {
  return fp.replace(/[:\s]/g, "").toLowerCase();
}

function extractCertifiedIdentity(cert: X509Certificate):
  | {
      ok: true;
      certifiedOperatorId: string;
      certifiedTenantId?: string;
    }
  | { ok: false; reason: string } {
  const san = parseSanUris(cert.subjectAltName);
  const operatorFromSan = san
    .map((uri) => matchSpiffe(uri, "operator"))
    .find((id): id is string => id !== undefined);
  const tenantFromSan = san
    .map((uri) => matchSpiffe(uri, "tenant"))
    .find((id): id is string => id !== undefined);

  // Identity precedence is intentional: a SPIFFE SAN URI is designed for
  // workload identity and is less ambiguous than the human-oriented Subject
  // CN. CN is accepted as a v1 fallback for simple CAF deployments.
  const operatorFromCn = parseSubjectCommonName(cert.subject);
  const certifiedOperatorId = operatorFromSan ?? operatorFromCn;
  if (certifiedOperatorId === undefined || certifiedOperatorId.length === 0) {
    return {
      ok: false,
      reason:
        "cert does not expose operator identity in SPIFFE SAN URI or subject CN",
    };
  }

  return {
    ok: true,
    certifiedOperatorId,
    ...(tenantFromSan !== undefined
      ? { certifiedTenantId: tenantFromSan }
      : {}),
  };
}

function parseSanUris(subjectAltName: string | undefined): string[] {
  if (subjectAltName === undefined) return [];
  const uris: string[] = [];
  const re = /(?:^|,\s*)URI:([^,]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(subjectAltName)) !== null) {
    uris.push(match[1]);
  }
  return uris;
}

function matchSpiffe(
  uri: string,
  kind: "operator" | "tenant",
): string | undefined {
  const prefix = `spiffe://brainstorm/${kind}/`;
  if (!uri.startsWith(prefix)) return undefined;
  const id = uri.slice(prefix.length);
  if (id.length === 0 || id.includes("/")) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return undefined;
  }
}

function parseSubjectCommonName(subject: string): string | undefined {
  const line = subject
    .split(/\r?\n/)
    .find((part) => part.trim().startsWith("CN="));
  if (line === undefined) return undefined;
  const cn = line.trim().slice("CN=".length);
  return cn.length > 0 ? cn : undefined;
}

/**
 * Constant-time-ish comparison for two equal-length hex strings.
 * Strings are short and under our control; this guards against the most
 * obvious side-channel without needing crypto.timingSafeEqual on byte
 * buffers.
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
