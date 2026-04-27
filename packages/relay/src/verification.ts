// Inbound verification — operator HMAC on DispatchRequest, endpoint
// connection_proof Ed25519 on EndpointHello.
//
// Both verifications use the canonical-form-with-domain-separation pattern
// from §3.3. This module is the integration point between raw frames and
// the foundation crypto in signing.ts / canonical.ts.

import * as ed25519 from "@noble/ed25519";

import { operatorHmac, constantTimeEqual } from "./signing.js";
import { SIGN_CONTEXT, signingInput } from "./canonical.js";
import { sha256 } from "@noble/hashes/sha256";

// ---------------------------------------------------------------------------

export type OperatorHmacVerifyResult =
  | { ok: true }
  | {
      ok: false;
      code: "AUTH_INVALID_PROOF" | "AUTH_MODE_NOT_SUPPORTED" | "AUTH_MALFORMED";
      message: string;
    };

/**
 * Verify operator HMAC on an inbound DispatchRequest.
 *
 * Per protocol-v1 §3.4:
 *   - For MVP, only `kind: "hmac_signed_envelope"` auth_proof is accepted
 *   - JWT and CAF mTLS modes return AUTH_MODE_NOT_SUPPORTED in MVP
 *   - HMAC is over OPERATOR_HMAC-prefixed canonical form of the request,
 *     with `operator.auth_proof.signature` set to "" before canonicalization
 *
 * Constant-time comparison on the resulting digest.
 */
export function verifyOperatorHmac(args: {
  request: Record<string, unknown>;
  hmacKey: Uint8Array;
}): OperatorHmacVerifyResult {
  if (args.hmacKey.length !== 32) {
    return {
      ok: false,
      code: "AUTH_MALFORMED",
      message: "operator hmacKey must be 32 bytes",
    };
  }
  const op = args.request.operator as
    | { auth_proof?: { kind?: string; signature?: string } }
    | undefined;
  if (!op || !op.auth_proof) {
    return {
      ok: false,
      code: "AUTH_MALFORMED",
      message: "request.operator.auth_proof missing",
    };
  }
  const kind = op.auth_proof.kind;
  if (kind === "jwt" || kind === "caf_mtls") {
    return {
      ok: false,
      code: "AUTH_MODE_NOT_SUPPORTED",
      message: `auth_proof.kind "${kind}" reserved for v1.0+; not accepted in MVP`,
    };
  }
  if (kind !== "hmac_signed_envelope") {
    return {
      ok: false,
      code: "AUTH_MALFORMED",
      message: `auth_proof.kind must be "hmac_signed_envelope"; got "${kind}"`,
    };
  }
  const claimedSigB64 = op.auth_proof.signature;
  if (typeof claimedSigB64 !== "string" || claimedSigB64.length === 0) {
    return {
      ok: false,
      code: "AUTH_MALFORMED",
      message: "auth_proof.signature must be a non-empty string",
    };
  }
  let claimedSigBytes: Uint8Array;
  try {
    claimedSigBytes = base64ToBytes(claimedSigB64);
  } catch {
    return {
      ok: false,
      code: "AUTH_MALFORMED",
      message: "auth_proof.signature must be base64-decodable",
    };
  }
  if (claimedSigBytes.length !== 32) {
    return {
      ok: false,
      code: "AUTH_INVALID_PROOF",
      message: "HMAC-SHA-256 signature must be exactly 32 bytes",
    };
  }
  // Compute expected HMAC: deep clone, set auth_proof.signature = ""
  const clone = JSON.parse(JSON.stringify(args.request)) as Record<
    string,
    unknown
  >;
  const cloneOp = clone.operator as { auth_proof: { signature: string } };
  cloneOp.auth_proof.signature = "";
  const expectedDigest = operatorHmac(clone, args.hmacKey);
  if (!constantTimeEqual(expectedDigest, claimedSigBytes)) {
    return {
      ok: false,
      code: "AUTH_INVALID_PROOF",
      message: "operator HMAC verification failed",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------

export type ConnectionProofVerifyResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "ENDPOINT_PROOF_INVALID"
        | "ENDPOINT_PROOF_EXPIRED"
        | "ENDPOINT_PROOF_FUTURE_DATED"
        | "ENDPOINT_PROOF_MALFORMED";
      message: string;
    };

const CONNECTION_PROOF_CLOCK_SKEW_SECONDS = 60;

/**
 * Verify an EndpointHello connection_proof per protocol-v1 §3.1.
 *
 * Signed bytes are SIGN_CONTEXT.CONNECTION_PROOF prefix + JCS-canonical(
 *   { endpoint_id, tenant_id, ts }
 * ). Ed25519 signature against the endpoint's stored public key.
 *
 * Clock-skew bounded: relay rejects proofs whose ts is more than 60s in the
 * past or future.
 */
export async function verifyConnectionProof(args: {
  endpoint_id: string;
  tenant_id: string;
  proof: { ts: string; signature: string };
  endpointPublicKey: Uint8Array;
  now?: () => Date;
}): Promise<ConnectionProofVerifyResult> {
  const now = args.now ? args.now() : new Date();
  const proofTs = new Date(args.proof.ts);
  if (Number.isNaN(proofTs.getTime())) {
    return {
      ok: false,
      code: "ENDPOINT_PROOF_MALFORMED",
      message: "connection_proof.ts is not a valid ISO8601 date",
    };
  }
  const skewMs = CONNECTION_PROOF_CLOCK_SKEW_SECONDS * 1000;
  const ageMs = now.getTime() - proofTs.getTime();
  if (ageMs > skewMs) {
    return {
      ok: false,
      code: "ENDPOINT_PROOF_EXPIRED",
      message: `connection_proof.ts is ${ageMs}ms old (max ${skewMs}ms)`,
    };
  }
  if (ageMs < -skewMs) {
    return {
      ok: false,
      code: "ENDPOINT_PROOF_FUTURE_DATED",
      message: `connection_proof.ts is ${-ageMs}ms in the future (max ${skewMs}ms)`,
    };
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(args.proof.signature);
  } catch {
    return {
      ok: false,
      code: "ENDPOINT_PROOF_MALFORMED",
      message: "connection_proof.signature must be base64-decodable",
    };
  }
  // Reconstruct signing input: prefix || JCS({endpoint_id, tenant_id, ts})
  const payload = {
    endpoint_id: args.endpoint_id,
    tenant_id: args.tenant_id,
    ts: args.proof.ts,
  };
  const input = signingInput(SIGN_CONTEXT.CONNECTION_PROOF, payload);
  const digest = sha256(input);
  let valid: boolean;
  try {
    valid = await ed25519.verifyAsync(sigBytes, digest, args.endpointPublicKey);
  } catch {
    valid = false;
  }
  if (!valid) {
    return {
      ok: false,
      code: "ENDPOINT_PROOF_INVALID",
      message: "Ed25519 signature verification failed",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
