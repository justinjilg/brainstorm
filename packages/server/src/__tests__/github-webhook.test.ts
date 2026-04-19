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
