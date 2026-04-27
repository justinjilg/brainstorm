// Ed25519 signing for the dispatch system, with domain-separated contexts
// and the canonical signing-input from canonical.ts.
//
// Algorithm per protocol-v1 §3.3: ed25519-jcs-sha256-v1.
//   1. Construct envelope JSON with `signature` field set to "" (empty string)
//   2. NFC-normalize every string in the envelope tree
//   3. JCS-serialize → canonical UTF-8 bytes
//   4. Prepend SIGN_CONTEXT prefix (here: COMMAND_ENVELOPE)
//   5. SHA-256 hash the prefixed bytes
//   6. Ed25519-sign the hash
//   7. Place base64-encoded signature in envelope's `signature` field
//
// Verification reverses this: extract signature, set envelope's `signature`
// to "", reconstruct canonical form, SHA-256 hash, Ed25519 verify.
//
// HMAC for operator auth (HMAC-SHA-256 over OPERATOR_HMAC-prefixed canonical
// form of DispatchRequest, excluding `auth_proof.signature`) follows the same
// shape but uses HMAC instead of Ed25519.

import { sha256 } from "@noble/hashes/sha256";
import { hmac } from "@noble/hashes/hmac";
import * as ed25519 from "@noble/ed25519";

import { SIGN_CONTEXT, type SignContext, signingInput } from "./canonical.js";

export const SIGNATURE_ALGO = "ed25519-jcs-sha256-v1" as const;
export type SignatureAlgo = typeof SIGNATURE_ALGO;

// --- Ed25519 envelope signing ----------------------------------------------

export interface SignableEnvelope {
  signature: string;
  signature_algo?: SignatureAlgo;
  // ...other envelope fields, opaque from the signing module's POV
  [key: string]: unknown;
}

/**
 * Compute the SHA-256 hash that Ed25519 signs over.
 *
 * Returns a 32-byte digest. Caller passes this to Ed25519 sign or verify.
 */
export function digestForSigning(
  context: SignContext,
  envelopeWithEmptySignature: SignableEnvelope,
): Uint8Array {
  if (envelopeWithEmptySignature.signature !== "") {
    throw new Error(
      "digestForSigning: envelope's signature field must be empty string before canonicalization",
    );
  }
  const input = signingInput(context, envelopeWithEmptySignature);
  return sha256(input);
}

/**
 * Sign an envelope: returns the envelope with its `signature` field
 * populated (base64-encoded Ed25519 signature) and `signature_algo` set.
 *
 * privateKey is 32 bytes (Ed25519 private key seed).
 */
export async function signEnvelope<T extends SignableEnvelope>(
  context: SignContext,
  envelope: T,
  privateKey: Uint8Array,
): Promise<T & { signature: string; signature_algo: SignatureAlgo }> {
  const draft = { ...envelope, signature: "", signature_algo: SIGNATURE_ALGO };
  const digest = digestForSigning(context, draft);
  const sigBytes = await ed25519.signAsync(digest, privateKey);
  draft.signature = base64Encode(sigBytes);
  return draft as T & { signature: string; signature_algo: SignatureAlgo };
}

/**
 * Verify an envelope's signature against a known public key.
 *
 * Returns true on valid signature. False on signature mismatch, wrong algo,
 * or canonicalization failure.
 *
 * publicKey is 32 bytes (Ed25519 public key).
 */
export async function verifyEnvelope(
  context: SignContext,
  envelope: SignableEnvelope,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (envelope.signature_algo !== SIGNATURE_ALGO) {
    return false;
  }
  const claimedSig = envelope.signature;
  if (typeof claimedSig !== "string" || claimedSig.length === 0) {
    return false;
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64Decode(claimedSig);
  } catch {
    return false;
  }
  const reconstructed: SignableEnvelope = { ...envelope, signature: "" };
  const digest = digestForSigning(context, reconstructed);
  try {
    return await ed25519.verifyAsync(sigBytes, digest, publicKey);
  } catch {
    return false;
  }
}

// --- HMAC operator auth ----------------------------------------------------

/**
 * Low-level HMAC primitive: caller is fully responsible for the
 * canonicalization invariants. PREFER `operatorHmacDispatchRequest()` for
 * DispatchRequest-shaped objects, which enforces invariants automatically.
 *
 * Compute HMAC-SHA-256 over the OPERATOR_HMAC-prefixed canonical form of
 * any object. Returns 32 bytes (HMAC digest).
 */
export function operatorHmac(
  canonicalizableObject: Record<string, unknown>,
  hmacKey: Uint8Array,
): Uint8Array {
  if (hmacKey.length !== 32) {
    throw new Error(
      `operatorHmac: hmacKey must be 32 bytes (HKDF-SHA-256 output); got ${hmacKey.length}`,
    );
  }
  const input = signingInput(SIGN_CONTEXT.OPERATOR_HMAC, canonicalizableObject);
  return hmac(sha256, hmacKey, input);
}

/**
 * Safer wrapper for DispatchRequest HMAC. Per protocol-v1 §3.4, HMAC
 * canonicalizes the request EXCLUDING `auth_proof.signature` (that field
 * is the signature itself; including it would be circular).
 *
 * This helper:
 *   - Deep-clones the request (does not mutate caller's object)
 *   - Asserts `operator.auth_proof.kind === "hmac_signed_envelope"`
 *   - Sets nested `operator.auth_proof.signature = ""`
 *   - Computes HMAC over the resulting canonical form
 *   - Asserts hmacKey is 32 bytes (matches HKDF-SHA-256 output)
 *
 * Returns 32 bytes (HMAC digest). Caller base64/hex-encodes for the wire.
 */
export function operatorHmacDispatchRequest(
  request: Record<string, unknown>,
  hmacKey: Uint8Array,
): Uint8Array {
  if (hmacKey.length !== 32) {
    throw new Error(
      `operatorHmacDispatchRequest: hmacKey must be 32 bytes; got ${hmacKey.length}`,
    );
  }
  // Deep clone to avoid mutating caller's object
  const clone = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  const op = clone.operator as
    | { auth_proof?: { kind?: string; signature?: string } }
    | undefined;
  if (!op || !op.auth_proof) {
    throw new Error(
      "operatorHmacDispatchRequest: request.operator.auth_proof missing",
    );
  }
  if (op.auth_proof.kind !== "hmac_signed_envelope") {
    throw new Error(
      `operatorHmacDispatchRequest: auth_proof.kind must be "hmac_signed_envelope"; got "${op.auth_proof.kind}"`,
    );
  }
  // Set signature to empty string — the canonicalization invariant
  op.auth_proof.signature = "";
  return operatorHmac(clone, hmacKey);
}

/**
 * Constant-time comparison of two byte arrays of equal length. For HMAC
 * verification — must NOT use === or naive == on the hex string because
 * those are short-circuit and timing-leaky.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// --- base64 helpers (URL-safe vs standard explicit) ------------------------

function base64Encode(bytes: Uint8Array): string {
  // Standard (not URL-safe) base64 for signature transport — matches the
  // RFC 7515 / JOSE convention, which is widely supported.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
