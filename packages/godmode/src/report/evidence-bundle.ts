/**
 * God Mode Evidence Bundle — HMAC-signed, tamper-evident wrapper around a
 * generated HTML ChangeSet report.
 *
 * The bundle binds three things together under one HMAC signature:
 *   1. the audit entries themselves,
 *   2. the moment of generation, and
 *   3. a SHA-256 hash of the exact HTML report string.
 *
 * A verifier recomputes the report hash and the signature; tampering with
 * either the HTML or any payload field is detected and reported with a
 * distinct reason. Signing reuses the platform's per-tenant key derivation
 * (deriveTenantKey) and canonical JSON (canonicalize) from signing.ts, so the
 * scheme is consistent with cross-product platform-event signing.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AuditEntry } from "../audit.js";
import { canonicalize, deriveTenantKey } from "../signing.js";

/** Default key-derivation tenant id when the caller does not scope by tenant. */
const DEFAULT_KEY_ID = "audit-evidence";

export interface EvidenceBundle {
  payload: {
    entries: AuditEntry[];
    generatedAt: number;
    /** Lowercase hex SHA-256 of the exact HTML report string. */
    reportSha256: string;
  };
  /** HMAC-SHA256 hex over canonicalize(payload). */
  signature: string;
  algorithm: "hmac-sha256";
  /** Tenant id used to derive the signing key (also the key identifier). */
  keyId: string;
}

export interface CreateEvidenceBundleOptions {
  /** Tenant id for key derivation. Defaults to "audit-evidence". */
  tenantId?: string;
  /** Generation timestamp (epoch ms). Defaults to Date.now(). */
  generatedAt?: number;
}

/** Lowercase hex SHA-256 of a string. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** HMAC-SHA256 hex of the canonicalized payload under the tenant key. */
function signPayload(
  payload: EvidenceBundle["payload"],
  masterSecret: string,
  tenantId: string,
): string {
  const key = deriveTenantKey(masterSecret, tenantId);
  const canonical = canonicalize(payload as unknown as Record<string, unknown>);
  return createHmac("sha256", key).update(canonical).digest("hex");
}

/**
 * Create a signed evidence bundle over the given audit entries and their
 * rendered HTML report. The caller is responsible for generating `reportHtml`
 * (e.g. via renderChangeSetReport) — the bundle hashes exactly that string, so
 * pass the identical HTML that will be archived alongside the bundle.
 */
export function createEvidenceBundle(
  entries: AuditEntry[],
  reportHtml: string,
  masterSecret: string,
  opts: CreateEvidenceBundleOptions = {},
): EvidenceBundle {
  const tenantId = opts.tenantId ?? DEFAULT_KEY_ID;
  const generatedAt = opts.generatedAt ?? Date.now();

  const payload: EvidenceBundle["payload"] = {
    entries,
    generatedAt,
    reportSha256: sha256Hex(reportHtml),
  };

  const signature = signPayload(payload, masterSecret, tenantId);

  return {
    payload,
    signature,
    algorithm: "hmac-sha256",
    keyId: tenantId,
  };
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/** Timing-safe hex comparison, mirroring signing.ts's verifyEvent style. */
function hexEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify an evidence bundle against the HTML it claims to describe.
 *
 * Checks, in order:
 *   1. the recomputed SHA-256 of `reportHtml` matches payload.reportSha256
 *      (detects HTML tampering) — distinct reason;
 *   2. the recomputed HMAC over the canonical payload matches the signature
 *      (detects any payload-field tampering, or a wrong/rotated key/tenant) —
 *      distinct reason.
 */
export function verifyEvidenceBundle(
  bundle: EvidenceBundle,
  reportHtml: string,
  masterSecret: string,
): VerifyResult {
  if (!bundle || typeof bundle !== "object") {
    return { valid: false, reason: "malformed-bundle" };
  }
  if (bundle.algorithm !== "hmac-sha256") {
    return { valid: false, reason: "unsupported-algorithm" };
  }
  if (!bundle.payload || typeof bundle.payload !== "object") {
    return { valid: false, reason: "malformed-payload" };
  }
  if (typeof bundle.signature !== "string" || bundle.signature.length === 0) {
    return { valid: false, reason: "missing-signature" };
  }
  // A tampered/corrupted bundle can carry a non-string reportSha256 (e.g.
  // 42), which would make Buffer.from(x, "hex") throw inside hexEqual —
  // verifiers must report malformed input, not crash on it.
  if (typeof bundle.payload.reportSha256 !== "string") {
    return { valid: false, reason: "malformed-payload" };
  }

  // 1. Report hash — detects tampering of the HTML itself.
  const actualHash = sha256Hex(reportHtml);
  if (!hexEqual(actualHash, bundle.payload.reportSha256)) {
    return { valid: false, reason: "report-hash-mismatch" };
  }

  // 2. Signature — detects tampering of any payload field, or a wrong key/tenant.
  const expectedSig = signPayload(
    bundle.payload,
    masterSecret,
    bundle.keyId ?? DEFAULT_KEY_ID,
  );
  if (!hexEqual(bundle.signature, expectedSig)) {
    return { valid: false, reason: "signature-mismatch" };
  }

  return { valid: true };
}
