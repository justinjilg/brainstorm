// Canonical form: NFC-normalize string values, then RFC 8785 JCS serialize.
//
// Per protocol-v1 §3.3 step 2: NFC each string value during/before JCS
// serialization, never after JCS produces canonical bytes. NFC-then-JCS is
// correct; JCS-then-NFC would mutate already-canonical bytes and break
// signature verification.
//
// Domain-separation prefixes per protocol-v1 §3.3 — every signing context
// has its own SIGN_CONTEXT_PREFIX. Cross-context signature replay (using a
// CommandEnvelope signature as a connection proof) fails because the prefix
// differs.

import canonicalize from "canonicalize";

export const SIGN_CONTEXT = {
  COMMAND_ENVELOPE: "brainstorm-cmd-envelope-v1\x00",
  CONNECTION_PROOF: "brainstorm-conn-proof-v1\x00",
  BOOTSTRAP_TOKEN: "brainstorm-bootstrap-token-v1\x00",
  OPERATOR_HMAC: "brainstorm-operator-hmac-v1\x00",
  EVIDENCE_CHUNK: "brainstorm-evidence-chunk-v1\x00",
} as const;

export type SignContext = (typeof SIGN_CONTEXT)[keyof typeof SIGN_CONTEXT];

/**
 * Thrown when normalization detects a key collision after NFC, e.g. an
 * object containing both `"café"` (NFD) and `"café"` (NFC) — these
 * normalize to the same key, and last-write-wins would violate signing
 * injectivity.
 */
export class NfcKeyCollisionError extends Error {
  constructor(public readonly normalizedKey: string) {
    super(
      `nfcNormalize: NFC key collision on "${normalizedKey}" — input contained two distinct keys that normalize to the same form. This breaks signing injectivity and is rejected as a hard canonicalization error.`,
    );
    this.name = "NfcKeyCollisionError";
  }
}

/**
 * Recursively NFC-normalize every string value within a JSON-compatible
 * value (returns a new value tree). Object keys are also normalized — JCS
 * requires deterministic key ordering, and equivalent Unicode forms must
 * compare equal for that ordering to be stable.
 *
 * Two cryptographic-injectivity defenses are mandatory and enforced here:
 *
 *   (1) Output objects are constructed with `Object.create(null)` + explicit
 *       `Object.defineProperty`. This prevents the legacy `__proto__`
 *       setter from being invoked when a wire object contains a
 *       `"__proto__"` key — naive assignment would silently DROP that key
 *       from the canonical form, allowing an attacker to smuggle a
 *       `__proto__` field past signing.
 *
 *   (2) NFC-key collisions throw `NfcKeyCollisionError`. Two distinct
 *       wire keys that normalize to the same form (e.g. `"café"`
 *       NFD and `"café"` NFC) would otherwise produce last-write-wins
 *       canonical bytes — violating injectivity since the original object
 *       carries both keys to handlers but the signature only binds one.
 *
 * Invariant: NFC-normalize EVERY string (values + keys) BEFORE JCS
 * serialization. Never apply NFC to JCS output bytes — that would mutate
 * already-canonical bytes and break signature verification.
 */
export function nfcNormalize<T>(value: T): T {
  if (typeof value === "string") {
    return value.normalize("NFC") as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => nfcNormalize(v)) as T;
  }
  if (value !== null && typeof value === "object") {
    // Use null-prototype object to avoid legacy __proto__ setter behavior.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      const normalizedKey = k.normalize("NFC");
      // Hard reject duplicate normalized keys (NFC injectivity defense).
      if (Object.prototype.hasOwnProperty.call(out, normalizedKey)) {
        throw new NfcKeyCollisionError(normalizedKey);
      }
      Object.defineProperty(out, normalizedKey, {
        value: nfcNormalize(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out as T;
  }
  return value;
}

/**
 * Produce the canonical bytes for signing.
 *
 * Steps (per protocol-v1 §3.3):
 *   1. NFC-normalize every string in the object tree
 *   2. JCS serialize (RFC 8785) — deterministic key ordering, normalized numbers
 *   3. Encode result as UTF-8
 *   4. Caller prepends SIGN_CONTEXT prefix before hashing/signing
 *
 * Returns UTF-8 bytes of the JCS canonical JSON; does NOT include the
 * SIGN_CONTEXT prefix (caller's responsibility — prefix differs per context).
 */
export function canonicalBytes(value: unknown): Uint8Array {
  const normalized = nfcNormalize(value);
  const jcs = canonicalize(normalized);
  if (jcs === undefined) {
    throw new Error(
      "canonicalize returned undefined; input is not JSON-serializable",
    );
  }
  return new TextEncoder().encode(jcs);
}

/**
 * Concatenate SIGN_CONTEXT prefix bytes with canonical bytes for the value.
 *
 * Output is the exact byte sequence to be SHA-256 hashed before Ed25519
 * signing or HMAC.
 */
export function signingInput(context: SignContext, value: unknown): Uint8Array {
  const prefix = new TextEncoder().encode(context);
  const body = canonicalBytes(value);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}
