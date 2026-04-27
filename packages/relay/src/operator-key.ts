// HKDF-SHA-256 operator HMAC key derivation per protocol-v1 §3.2.
//
// Mandatory derivation; cross-implementation interop depends on the exact
// formula. Was an "implementer choice" in v1 of the spec; tightened to a
// mandate in v2 (Codex F19/§14.1 fix).
//
//   hmac_key = HKDF-SHA-256(
//     ikm  = api_key_bytes,
//     salt = "brainstorm-relay-operator-hmac-v1",
//     info = canonical("operator_id|" + operator_id + "|tenant_id|" + tenant_id),
//     length = 32
//   )

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

const HKDF_SALT = new TextEncoder().encode("brainstorm-relay-operator-hmac-v1");

export interface OperatorKeyDerivationInput {
  apiKey: string | Uint8Array;
  operatorId: string;
  tenantId: string;
}

/**
 * Derive a 32-byte HMAC key from an operator's API key + identity.
 *
 * Both relay and operator client must compute the SAME key for the same
 * inputs — this is the interop contract. Use only this function; do not
 * roll your own derivation.
 */
export function deriveOperatorHmacKey(
  input: OperatorKeyDerivationInput,
): Uint8Array {
  const ikm =
    typeof input.apiKey === "string"
      ? new TextEncoder().encode(input.apiKey)
      : input.apiKey;
  const info = new TextEncoder().encode(
    `operator_id|${input.operatorId}|tenant_id|${input.tenantId}`,
  );
  return hkdf(sha256, ikm, HKDF_SALT, info, 32);
}
