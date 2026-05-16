import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createWebhookHandler } from "../github-webhook.js";

const SECRET = "test-webhook-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function pushBody() {
  return JSON.stringify({
    ref: "refs/heads/main",
    before: "aaa",
    after: "bbb",
    repository: { full_name: "o/r", default_branch: "main" },
    commits: [],
    pusher: { name: "test", email: "t@t" },
  });
}

describe("github webhook handler", () => {
  it("drops payloads with no X-GitHub-Delivery header as replay-suspect", async () => {
    const onPush = vi.fn();
    const handler = createWebhookHandler({ webhookSecret: SECRET, onPush });

    const body = pushBody();
    const res = await handler(body, {
      "x-hub-signature-256": sign(body),
      "x-github-event": "push",
      // no x-github-delivery
    });

    // Handler is lenient (returns 200 with duplicate: true) so GitHub does
    // not keep retrying, but the handler must NOT have invoked the push
    // callback for an attacker-stripped delivery.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ duplicate: true });
    expect(onPush).not.toHaveBeenCalled();
  });

  it("drops an exact replay (same delivery id twice)", async () => {
    const onPush = vi.fn().mockResolvedValue(undefined);
    const handler = createWebhookHandler({ webhookSecret: SECRET, onPush });

    const body = pushBody();
    const headers = {
      "x-hub-signature-256": sign(body),
      "x-github-event": "push",
      "x-github-delivery": "delivery-abc-123",
    };

    await handler(body, headers);
    const second = await handler(body, headers);

    expect(second.body).toMatchObject({ duplicate: true });
    // onPush fired exactly once — first delivery only.
    expect(onPush).toHaveBeenCalledTimes(1);
  });

  it("unsigned request with guessed delivery id does not poison nonce cache", async () => {
    // Regression: isReplay() mutates the nonce cache on first sight. If
    // it ran before signature verification, an attacker who guessed a
    // delivery ID could preempt the legit GitHub delivery by sending an
    // unsigned request with that ID first — the cache entry would then
    // cause the real delivery to be rejected as "duplicate" and onPush
    // would never fire. Correct behaviour: signature failures must NOT
    // touch the nonce cache.
    const onPush = vi.fn().mockResolvedValue(undefined);
    const handler = createWebhookHandler({ webhookSecret: SECRET, onPush });

    const body = pushBody();
    const deliveryId = "delivery-guessed-xyz";

    // Attacker: invalid signature, guessed delivery ID.
    const poisoned = await handler(body, {
      "x-hub-signature-256": "sha256=" + "00".repeat(32),
      "x-github-event": "push",
      "x-github-delivery": deliveryId,
    });
    expect(poisoned.status).toBe(401);
    expect(onPush).not.toHaveBeenCalled();

    // GitHub's real delivery with the same ID must still be accepted.
    const legit = await handler(body, {
      "x-hub-signature-256": sign(body),
      "x-github-event": "push",
      "x-github-delivery": deliveryId,
    });
    expect(legit.status).toBe(200);
    expect(legit.body).not.toMatchObject({ duplicate: true });
    expect(onPush).toHaveBeenCalledTimes(1);
  });

  it("accepts a fresh delivery with signature and header", async () => {
    const onPush = vi.fn().mockResolvedValue(undefined);
    const handler = createWebhookHandler({ webhookSecret: SECRET, onPush });

    const body = pushBody();
    const res = await handler(body, {
      "x-hub-signature-256": sign(body),
      "x-github-event": "push",
      "x-github-delivery": "delivery-fresh-" + Math.random().toString(36),
    });

    expect(res.status).toBe(200);
    expect(onPush).toHaveBeenCalledTimes(1);
  });
});

// ── v13 Attacker bypass #3: webhook nonce burst-replay (path-to-90 P9b) ──

describe("github-webhook — LRU nonce cache (P9b)", () => {
  // Reach into the internal cache-management surface via the test-only
  // exports. These are intentionally non-public — they exist so this
  // regression suite can pin the burst-replay defense without spinning
  // up a full handler + 100k signed deliveries.

  it("bounds cache size and supports repeat-detection on inserted nonces", async () => {
    const mod = await import("../github-webhook.js");
    mod.__resetNonceCacheForTests();
    expect(mod.__nonceCacheSizeForTests()).toBe(0);

    // Insert 1000 unique fresh nonces and confirm each is registered
    // as first-sight (not replay) and the cache grows accordingly.
    for (let i = 0; i < 1000; i++) {
      const isReplay = mod.__isReplayForTests(`burst-${i}`);
      expect(isReplay, `burst-${i} should be first-sight`).toBe(false);
    }
    expect(mod.__nonceCacheSizeForTests()).toBe(1000);

    // Replay one of those nonces — must be detected.
    expect(mod.__isReplayForTests("burst-500")).toBe(true);

    // Cache size is bounded by MAX_NONCE_CACHE (default 100_000); after
    // 1000 fresh inserts, size is 1000. Pre-fix, the v13 Attacker noted
    // that ONLY age-prune ran, so a burst within 5 minutes could grow
    // the cache unboundedly (DoS) AND the original captured nonce could
    // sit on the periphery and replay after age-eviction. Now LRU
    // eviction triggers on cap hit regardless of age — bounded memory.
    expect(mod.__nonceCacheSizeForTests()).toBeLessThanOrEqual(100_000);

    mod.__resetNonceCacheForTests();
  });

  it("repeat-replay on the same delivery id is rejected", async () => {
    const mod = await import("../github-webhook.js");
    mod.__resetNonceCacheForTests();
    expect(mod.__isReplayForTests("repeat-id")).toBe(false);
    expect(mod.__isReplayForTests("repeat-id")).toBe(true);
    expect(mod.__isReplayForTests("repeat-id")).toBe(true);
    mod.__resetNonceCacheForTests();
  });

  it("missing or empty X-GitHub-Delivery is treated as replay-suspect", async () => {
    const mod = await import("../github-webhook.js");
    mod.__resetNonceCacheForTests();
    expect(mod.__isReplayForTests(undefined)).toBe(true);
    expect(mod.__isReplayForTests("")).toBe(true);
    // The cache should be empty afterward — replay-suspect drops do
    // NOT register a nonce (no false-positive future-replay).
    expect(mod.__nonceCacheSizeForTests()).toBe(0);
  });
});
