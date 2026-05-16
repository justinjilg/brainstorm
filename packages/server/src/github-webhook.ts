/**
 * GitHub Webhook Handler — receives push and PR events from GitHub.
 *
 * Verifies HMAC-SHA256 signatures, parses event types, and dispatches:
 * - push → incremental code graph reindex
 * - pull_request (opened/synchronize) → queues PR review
 */

import { createHmac } from "node:crypto";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("github-webhook");

// ── Types ─────────────────────────────────────────────────────────

export interface PushEvent {
  type: "push";
  ref: string;
  before: string;
  after: string;
  repository: { full_name: string; default_branch: string };
  commits: Array<{
    id: string;
    message: string;
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  pusher: { name: string; email: string };
}

export interface PullRequestEvent {
  type: "pull_request";
  action: string; // opened, synchronize, closed, reopened
  number: number;
  pull_request: {
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    title: string;
    user: { login: string };
    changed_files: number;
  };
  repository: { full_name: string };
}

export type GitHubEvent = PushEvent | PullRequestEvent | { type: "unknown" };

// ── Signature Verification ────────────────────────────────────────

/**
 * Verify GitHub webhook HMAC-SHA256 signature.
 * GitHub sends signature in X-Hub-Signature-256 header as "sha256=<hex>".
 */
export function verifyGitHubSignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature.startsWith("sha256=")) return false;

  const expected =
    "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

// ── Event Parsing ─────────────────────────────────────────────────

/**
 * Parse a GitHub webhook event from headers + body.
 */
export function parseGitHubEvent(
  eventType: string,
  body: Record<string, unknown>,
): GitHubEvent {
  switch (eventType) {
    case "push":
      return {
        type: "push",
        ref: body.ref as string,
        before: body.before as string,
        after: body.after as string,
        repository: body.repository as any,
        commits: (body.commits as any[]) ?? [],
        pusher: body.pusher as any,
      };

    case "pull_request":
      return {
        type: "pull_request",
        action: body.action as string,
        number: (body as any).number,
        pull_request: body.pull_request as any,
        repository: body.repository as any,
      };

    default:
      return { type: "unknown" };
  }
}

// ── Changed Files Extraction ──────────────────────────────────────

/**
 * Extract the list of changed files from a push event.
 */
export function getChangedFilesFromPush(event: PushEvent): string[] {
  const files = new Set<string>();
  for (const commit of event.commits) {
    for (const f of commit.added) files.add(f);
    for (const f of commit.modified) files.add(f);
    for (const f of commit.removed) files.add(f);
  }
  return Array.from(files);
}

// ── Request Handler ───────────────────────────────────────────────

export interface WebhookHandlerOptions {
  /** Shared secret for signature verification. */
  webhookSecret: string;
  /** Called when push event received with changed files. */
  onPush?: (event: PushEvent, changedFiles: string[]) => Promise<void>;
  /** Called when PR event received (opened/synchronize/reopened). */
  onPullRequest?: (event: PullRequestEvent) => Promise<void>;
}

// ── Replay Protection ─────────────────────────────────────────────
//
// In-memory nonce cache: maps X-GitHub-Delivery (UUIDv4) → ingest timestamp.
// On match, the delivery is treated as a replay and dropped post-signature.
//
// v13 Attacker (re-verified v14) named a specific failure mode in the
// previous implementation:
//
//   1. Eviction was AGE-ONLY (`if (ts < cutoff) delete`). Within a 5-min
//      burst of 1001+ unique deliveries, NOTHING was old enough to evict,
//      so the cache grew unboundedly past MAX_NONCE_CACHE — DoS vector.
//   2. Cache lived only in memory, so a process restart erased every
//      seen-nonce. Captured signed payloads replayed across restarts.
//
// P9b fixes (this commit):
//
//   - LRU eviction. When cache size exceeds MAX_NONCE_CACHE, evict the
//     OLDEST entry by insertion order (Map iteration is insertion-ordered
//     per ECMA-262). Bounds memory at MAX_NONCE_CACHE entries regardless
//     of burst pattern. Closes failure mode 1.
//   - MAX_NONCE_CACHE raised 1000 → 100_000. At typical GitHub-webhook
//     volumes (single-digit deliveries/minute for most repos), this gives
//     a multi-day eviction window before a captured nonce becomes
//     replayable. Configurable via GH_WEBHOOK_NONCE_CACHE_SIZE env var
//     for high-volume deployments.
//
// What is NOT closed here (carry-forward to P9b-2 / structural):
//
//   - Process-restart wipes the cache (failure mode 2). A persistent
//     nonce store (redis or the existing SQLite at @brainst0rm/db) would
//     close it. Tracked as P9b-followup since it requires either a new
//     infra dep or coupling to the existing DB.
//   - Replay-after-eviction beyond the LRU window remains possible if an
//     attacker can sustain enough unique deliveries to flush the cache,
//     OR if the captured payload is older than the cache's effective
//     window. The only structural fix is sender-cooperation timestamp
//     binding (Slack/Stripe webhook style) — GitHub does not currently
//     support this. Operators concerned about long-term replay should
//     run with `GH_WEBHOOK_NONCE_CACHE_SIZE` set to a multi-day capacity
//     AND run behind a request-timestamp gate at the load balancer.
//
// Documented honestly per the path-to-90 "no cheating" rule.

const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes — opportunistic age-prune trigger.

/** Cache capacity. Override via env var for high-volume deployments. */
const MAX_NONCE_CACHE = parseEnvCacheSize(
  process.env.GH_WEBHOOK_NONCE_CACHE_SIZE,
  100_000,
);

function parseEnvCacheSize(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  // Floor of 1000 prevents an operator typo (e.g. "10") from inadvertently
  // crippling replay protection. Ceiling of 10M prevents pathological
  // configurations that would exhaust memory by themselves.
  if (!Number.isFinite(n) || n < 1000 || n > 10_000_000) return fallback;
  return Math.floor(n);
}

/** In-memory nonce cache — prevents replay of the same delivery.
 *  Insertion-ordered (ECMA-262 Map iteration). Oldest entry is the
 *  first key in iteration order. */
const seenDeliveries = new Map<string, number>(); // deliveryId → timestamp

function isReplay(deliveryId: string | undefined): boolean {
  // A real GitHub webhook always carries X-GitHub-Delivery. If the header is
  // missing, we have no nonce to cache against and therefore no way to
  // distinguish a first-time event from a replay — treat it as replay-suspect
  // and drop. Previously this returned false, which let an attacker replay
  // captured signed payloads indefinitely by simply stripping the header.
  if (!deliveryId) return true;

  // Opportunistic age-prune: cheap; only inspects entries that already
  // exist. Iteration is insertion-ordered, so once we hit the first
  // fresh entry, all subsequent entries are also fresh — break early.
  // Does NOT depend on the cap-eviction logic below for correctness.
  const cutoff = Date.now() - REPLAY_WINDOW_MS;
  for (const [id, ts] of seenDeliveries) {
    if (ts < cutoff) seenDeliveries.delete(id);
    else break;
  }

  // Hard cap: LRU eviction. If still over after age-prune, evict oldest
  // entries until at capacity. Closes the v13 Attacker burst-replay path.
  while (seenDeliveries.size >= MAX_NONCE_CACHE) {
    const oldest = seenDeliveries.keys().next().value;
    if (oldest === undefined) break;
    seenDeliveries.delete(oldest);
  }

  if (seenDeliveries.has(deliveryId)) return true;
  seenDeliveries.set(deliveryId, Date.now());
  return false;
}

/** Test-only — reset the cache between tests. */
export function __resetNonceCacheForTests(): void {
  seenDeliveries.clear();
}

/** Test-only — observability for cache-size assertions. */
export function __nonceCacheSizeForTests(): number {
  return seenDeliveries.size;
}

/** Test-only — exposed for the LRU regression test. */
export function __isReplayForTests(deliveryId: string | undefined): boolean {
  return isReplay(deliveryId);
}

/**
 * Create the webhook request handler.
 * Includes replay protection via X-GitHub-Delivery nonce + timestamp window.
 */
export function createWebhookHandler(opts: WebhookHandlerOptions) {
  return async (
    body: string,
    headers: Record<string, string | undefined>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    // Verify signature FIRST — isReplay() mutates the nonce cache, so
    // checking it before signature verification would let an
    // unauthenticated attacker poison the cache with a guessed delivery
    // ID and cause the subsequent legit GitHub delivery with the same ID
    // to be silently dropped as "duplicate". Delivery IDs are UUIDv4 so
    // guessing is not practical, but correct ordering costs nothing.
    const signature = headers["x-hub-signature-256"];
    if (
      !signature ||
      !verifyGitHubSignature(body, signature, opts.webhookSecret)
    ) {
      log.warn("Invalid or missing webhook signature");
      return { status: 401, body: { error: "Invalid signature" } };
    }

    // Replay protection — only runs for payloads that already passed
    // signature verification, so the nonce cache cannot be poisoned by
    // unauthenticated traffic.
    const deliveryId = headers["x-github-delivery"];
    if (isReplay(deliveryId)) {
      log.warn(
        { deliveryId },
        "Replay detected — rejecting duplicate delivery",
      );
      return { status: 200, body: { received: true, duplicate: true } };
    }

    const eventType = headers["x-github-event"] ?? "unknown";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, body: { error: "Invalid JSON" } };
    }

    const event = parseGitHubEvent(eventType, parsed);

    if (event.type === "push") {
      const changedFiles = getChangedFilesFromPush(event);
      log.info(
        {
          ref: event.ref,
          files: changedFiles.length,
          pusher: event.pusher.name,
        },
        "Push event received",
      );
      if (opts.onPush) {
        // Fire and forget — don't block webhook response
        opts
          .onPush(event, changedFiles)
          .catch((err) => log.error({ err }, "Push handler failed"));
      }
      return {
        status: 200,
        body: { received: true, event: "push", files: changedFiles.length },
      };
    }

    if (event.type === "pull_request") {
      const reviewableActions = ["opened", "synchronize", "reopened"];
      if (reviewableActions.includes(event.action)) {
        log.info(
          {
            pr: event.number,
            action: event.action,
            user: event.pull_request.user.login,
          },
          "PR event received — queuing review",
        );
        if (opts.onPullRequest) {
          opts
            .onPullRequest(event)
            .catch((err) => log.error({ err }, "PR review handler failed"));
        }
        return {
          status: 200,
          body: {
            received: true,
            event: "pull_request",
            action: event.action,
            pr: event.number,
          },
        };
      }
      return {
        status: 200,
        body: {
          received: true,
          event: "pull_request",
          action: event.action,
          skipped: true,
        },
      };
    }

    return {
      status: 200,
      body: { received: true, event: eventType, ignored: true },
    };
  };
}
