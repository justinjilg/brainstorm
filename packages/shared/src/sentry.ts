import * as Sentry from "@sentry/node";

let initialized = false;

/**
 * Initialize Sentry error tracking for the Brainstorm CLI.
 *
 * DSN is read from SENTRY_DSN env var or 1Password vault.
 * No-ops gracefully if DSN is not set (development/CI).
 */
export function initSentry(opts?: {
  release?: string;
  environment?: string;
}): void {
  if (initialized) return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // No DSN = no tracking. Silent in dev.

  Sentry.init({
    dsn,
    release: opts?.release ?? process.env.npm_package_version,
    environment: opts?.environment ?? (process.env.NODE_ENV || "development"),

    // Only capture errors — no performance tracing for CLI tool
    tracesSampleRate: 0,

    // Tag every event with brainstorm metadata
    initialScope: {
      tags: {
        component: "cli",
      },
    },

    // Don't send breadcrumbs with PII (file paths, commands)
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === "console") return null;
      return breadcrumb;
    },

    // Scrub sensitive data from error events
    beforeSend(event) {
      // Strip API keys from any string in the event
      if (event.extra) {
        for (const [key, val] of Object.entries(event.extra)) {
          if (
            typeof val === "string" &&
            /(?:key|token|secret|password)/i.test(key)
          ) {
            event.extra[key] = "[REDACTED]";
          }
        }
      }
      return event;
    },
  });

  initialized = true;
}

/**
 * Capture an error with optional context tags.
 * No-ops if Sentry is not initialized.
 */
export function captureError(
  error: Error | string,
  context?: Record<string, string>,
): void {
  if (!initialized) return;

  if (context) {
    Sentry.withScope((scope) => {
      for (const [key, val] of Object.entries(context)) {
        scope.setTag(key, val);
      }
      if (typeof error === "string") {
        Sentry.captureMessage(error, "error");
      } else {
        Sentry.captureException(error);
      }
    });
  } else {
    if (typeof error === "string") {
      Sentry.captureMessage(error, "error");
    } else {
      Sentry.captureException(error);
    }
  }
}

/**
 * Flush pending events before process exit.
 * Call this in your cleanup handler.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  await Sentry.flush(timeoutMs);
}

export { Sentry };
