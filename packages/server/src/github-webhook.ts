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

/**
 * Create the webhook request handler.
 * Returns a function compatible with Node.js http.createServer.
 */
export function createWebhookHandler(opts: WebhookHandlerOptions) {
  return async (
    body: string,
    headers: Record<string, string | undefined>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    // Verify signature
    const signature = headers["x-hub-signature-256"];
    if (
      !signature ||
      !verifyGitHubSignature(body, signature, opts.webhookSecret)
    ) {
      log.warn("Invalid or missing webhook signature");
      return { status: 401, body: { error: "Invalid signature" } };
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
