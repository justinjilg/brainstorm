/**
 * Platform Event Signing — HMAC-SHA256 with per-tenant key derivation.
 *
 * Every cross-product event is signed so the receiver can verify authenticity
 * and detect tampering. Uses HKDF to derive a per-tenant HMAC key from the
 * platform master secret, so tenants can't forge events for each other.
 *
 * Canonical JSON: keys sorted, no whitespace. Deterministic across languages
 * so Python products produce the same signature as TypeScript ones.
 */

import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import type { PlatformEvent } from "@brainst0rm/shared";

const HKDF_SALT = Buffer.from("brainstorm-platform-events-v1");
const HKDF_INFO = Buffer.from("hmac-signing");
const KEY_LENGTH = 32; // 256-bit HMAC key

/**
 * Derive a per-tenant HMAC key from the platform master secret.
 * Uses HKDF-SHA256 with the tenant_id baked into the info parameter,
 * ensuring each tenant gets a unique signing key.
 */
export function deriveTenantKey(
  masterSecret: string,
  tenantId: string,
): Buffer {
  const info = Buffer.concat([HKDF_INFO, Buffer.from(`|${tenantId}`)]);
  return Buffer.from(
    hkdfSync("sha256", masterSecret, HKDF_SALT, info, KEY_LENGTH),
  );
}

/**
 * Produce canonical JSON for signing.
 * Keys sorted recursively, no whitespace. Matches Python's
 * json.dumps(obj, sort_keys=True, separators=(',', ':'))
 */
export function canonicalize(obj: Record<string, unknown>): string {
  // Recursive key-sorted JSON with no whitespace.
  // Matches Python's json.dumps(obj, sort_keys=True, separators=(',', ':'))
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce((sorted: Record<string, unknown>, k) => {
          sorted[k] = value[k];
          return sorted;
        }, {});
    }
    return value;
  });
}

/**
 * Sign a platform event payload.
 * Returns the HMAC-SHA256 hex signature.
 */
export function signEvent(
  event: Omit<PlatformEvent, "signature">,
  masterSecret: string,
): string {
  const key = deriveTenantKey(masterSecret, event.tenant_id);
  const payload = canonicalize(event as Record<string, unknown>);
  return createHmac("sha256", key).update(payload).digest("hex");
}

/**
 * Verify a signed platform event.
 * Uses timing-safe comparison to prevent timing attacks.
 */
/** Maximum age (in seconds) for a platform event to be accepted. */
const MAX_EVENT_AGE_SECONDS = 300; // 5 minutes

/**
 * Replay-dedupe cache for verified event ids.
 *
 * v16 Attacker finding: the freshness window alone is not sufficient. An
 * attacker who captures one signed event can replay it ~300×/sec for
 * 5 minutes — the signature is valid, the timestamp is within window, and
 * the server has no record that THIS event was already seen. Webhook
 * verification closed the same shape with an LRU nonce cache (PR #309);
 * platform events did not.
 *
 * Map keyed on event.id, value = wall-clock ms when first seen. Entries
 * expire passively at lookup (any entry older than the freshness window
 * is treated as evicted). The cache is also LRU-bounded so a flood of
 * fresh-but-bogus ids cannot blow memory.
 *
 * Exported for tests that need to reset state between cases.
 */
const seenEventIds = new Map<string, number>();
const MAX_SEEN_IDS = 100_000;
const FRESHNESS_MS = MAX_EVENT_AGE_SECONDS * 1000;

/** Test helper — drop all dedupe state. Production code MUST NOT call this. */
export function _resetSeenEventIdsForTesting(): void {
  seenEventIds.clear();
}

function checkAndRecordEventId(eventId: string, now: number): boolean {
  // Passive expiry: drop entries older than the freshness window. Done
  // lazily on every check so we don't need a sweeper timer.
  const cutoff = now - FRESHNESS_MS;
  // First, opportunistically evict ALL entries older than cutoff. Cheap
  // when the cache is small; with the LRU cap above this stays cheap.
  for (const [id, ts] of seenEventIds) {
    if (ts < cutoff) seenEventIds.delete(id);
  }

  if (seenEventIds.has(eventId)) {
    // Already seen within the freshness window — REPLAY.
    return false;
  }

  // LRU eviction if full — drop oldest entry by insertion order.
  if (seenEventIds.size >= MAX_SEEN_IDS) {
    const oldestKey = seenEventIds.keys().next().value;
    if (oldestKey !== undefined) seenEventIds.delete(oldestKey);
  }

  seenEventIds.set(eventId, now);
  return true;
}

export function verifyEvent(
  event: PlatformEvent,
  masterSecret: string,
): boolean {
  // Reject events without a signature
  if (!event.signature) return false;

  // Reject events without an id — required for replay dedupe
  if (!event.id) return false;

  // Replay protection step 1: require a parseable timestamp inside the
  // freshness window. A missing or malformed timestamp is treated as a
  // failed check, not skipped — otherwise a captured event could be
  // replayed forever by an attacker who strips or corrupts the field.
  if (!event.timestamp) return false;
  const eventTime = new Date(event.timestamp).getTime();
  if (Number.isNaN(eventTime)) return false;
  const ageMs = Math.abs(Date.now() - eventTime);
  if (ageMs > MAX_EVENT_AGE_SECONDS * 1000) return false;

  // Verify signature BEFORE recording id in the dedupe cache — otherwise
  // an attacker can spam fake ids to fill the LRU and evict legitimate
  // entries.
  const { signature, ...rest } = event;
  const expected = signEvent(rest, masterSecret);
  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return false;

  // Replay protection step 2: record event.id; reject if already seen
  // within the freshness window.
  return checkAndRecordEventId(event.id, Date.now());
}

/**
 * Create a signed PlatformEvent ready for transmission.
 */
export function createSignedEvent(
  type: string,
  tenantId: string,
  product: string,
  data: Record<string, unknown>,
  masterSecret: string,
  opts?: { correlationId?: string; schemaVersion?: number },
): PlatformEvent {
  const unsigned = {
    id: randomUUID(),
    type,
    tenant_id: tenantId,
    product,
    timestamp: new Date().toISOString(),
    data,
    schema_version: opts?.schemaVersion ?? 1,
    ...(opts?.correlationId ? { correlation_id: opts.correlationId } : {}),
  };

  const signature = signEvent(unsigned, masterSecret);
  return { ...unsigned, signature };
}
