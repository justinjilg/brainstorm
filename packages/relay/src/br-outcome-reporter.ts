// BR outcome reporter — fire-and-forget POST to BR's
// `/v1/agents/${agentId}/dispatch-outcomes` endpoint after every terminal
// command lifecycle (completed/failed/timed_out).
//
// Per design locked with peer 12xnwqbb:
//   - 7-day Idempotency-Key TTL on BR side; correlation_id is the key.
//   - Headers + body shape locked.
//   - Fire-and-forget: relay's audit/operator-fanout MUST NOT block on
//     BR's response.
//
// Honesty:
//   - BR-side endpoint doesn't exist yet (12xnwqbb gated on Justin).
//   - This code path must accept that BR may return 404 or never respond.
//   - Failure mode is silent-log + drop. We do NOT retry — the relay's
//     audit log is the source of truth; BR is a derived analytics view.
//     Retrying inside the relay would couple unrelated systems' liveness.
//   - There is NO local persistent queue. If the relay process crashes
//     between the audit-write and the BR POST, that outcome is lost on
//     BR's side — but the audit log retains it. Reconciliation from
//     audit-log → BR is a separate offline job (out of scope).
//
// Observable failure modes (all surface via logger.error, none thrown):
//   - Network error (ECONNREFUSED, timeout): logged, dropped.
//   - Non-2xx response (404, 500): logged with status, dropped.
//   - JSON serialization error: should never happen with our typed body
//     but logged + dropped if it somehow does.

// ---------------------------------------------------------------------------

export interface BrOutcomeReporterOptions {
  /** BR base URL, e.g. "https://api.brainstormrouter.com". No trailing slash. */
  baseUrl: string;
  /** Optional bearer token / API key to include as Authorization header. */
  apiKey?: string;
  /**
   * Optional fetch implementation for tests. Defaults to globalThis.fetch.
   * Tests inject a mock that records calls.
   */
  fetch?: typeof fetch;
  /** Logger for fire-and-forget failures. */
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
  /**
   * Per-call timeout (ms). Defaults to 5000. AbortController-driven so
   * a slow BR doesn't hold sockets indefinitely.
   */
  timeoutMs?: number;
}

export type DispatchOutcome = "completed" | "failed" | "timed_out";

export interface DispatchOutcomeReport {
  /** Agent the dispatch was bound to (used in URL path). */
  agentId: string;
  /** Idempotency key — also goes in the body for correlation. */
  correlation_id: string;
  outcome: DispatchOutcome;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  success: boolean;
  payload_size_in: number;
  payload_size_out: number;
  error_class?: string;
}

// ---------------------------------------------------------------------------

export class BrOutcomeReporter {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly log: {
    info: (m: string) => void;
    error: (m: string) => void;
  };
  private readonly timeoutMs: number;
  /** Counter for observability + tests. */
  private inflightCount_ = 0;

  constructor(opts: BrOutcomeReporterOptions) {
    // Strip trailing slashes without a regex — CodeQL flags `/\/+$/` as
    // polynomial-on-uncontrolled-data even though the input is config-time
    // (operator-supplied baseUrl), not network-sourced. A simple loop is
    // unambiguously linear and side-steps the alert.
    let normalisedBaseUrl = opts.baseUrl;
    while (normalisedBaseUrl.endsWith("/")) {
      normalisedBaseUrl = normalisedBaseUrl.slice(0, -1);
    }
    this.baseUrl = normalisedBaseUrl;
    this.apiKey = opts.apiKey;
    this.fetchImpl =
      opts.fetch ??
      ((globalThis as unknown as { fetch?: typeof fetch })
        .fetch as typeof fetch);
    if (this.fetchImpl === undefined) {
      throw new Error(
        "BrOutcomeReporter: no fetch implementation available (Node <18?). Pass opts.fetch.",
      );
    }
    this.log = opts.logger ?? {
      info: (_m: string) => {},
      error: (_m: string) => {},
    };
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  /**
   * Fire-and-forget report. Returns immediately; the actual POST runs
   * in the background. Errors are logged and dropped — the caller is
   * not blocked and is not informed of BR-side failures.
   *
   * Returns a Promise<void> that resolves when the POST attempt has
   * completed (success OR logged-failure), but callers in the relay
   * lifecycle path SHOULD NOT await it. The promise is exposed so tests
   * can verify the reporter ran without timing-flakery.
   */
  report(input: DispatchOutcomeReport): Promise<void> {
    // Defense-in-depth: relay ingress validates correlation_id, but this
    // reporter is public and callable directly from tests or future code
    // paths. Never allow control characters into HTTP header values.
    assertSafeHeaderValue(input.correlation_id, "correlation_id");
    this.inflightCount_ += 1;
    const promise = this.doReport(input).finally(() => {
      this.inflightCount_ -= 1;
    });
    // Attach a no-op catch so unhandled-rejection doesn't fire if doReport
    // somehow throws after our internal try/catch (defense-in-depth).
    promise.catch(() => {});
    return promise;
  }

  /**
   * Number of in-flight reports. Useful for graceful-shutdown drain in
   * tests + for observability. Reaches 0 only when all background POSTs
   * have settled.
   */
  inflightCount(): number {
    return this.inflightCount_;
  }

  private async doReport(input: DispatchOutcomeReport): Promise<void> {
    const url = `${this.baseUrl}/v1/agents/${encodeURIComponent(input.agentId)}/dispatch-outcomes`;
    const body = JSON.stringify({
      correlation_id: input.correlation_id,
      outcome: input.outcome,
      started_at: input.started_at,
      completed_at: input.completed_at,
      duration_ms: input.duration_ms,
      success: input.success,
      payload_size_in: input.payload_size_in,
      payload_size_out: input.payload_size_out,
      ...(input.error_class !== undefined
        ? { error_class: input.error_class }
        : {}),
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": input.correlation_id,
    };
    if (this.apiKey !== undefined) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    // AbortController-driven timeout — fire-and-forget but bounded.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        // Non-2xx: BR returned an error. Drop silently with a log line.
        // 404 is expected during the gating window (BR-side endpoint not
        // yet shipped); we log at info-level to avoid alarm-fatigue.
        if (res.status === 404) {
          this.log.info(
            `br-outcome: ${input.correlation_id} → 404 (BR endpoint not deployed yet); dropped`,
          );
        } else {
          this.log.error(
            `br-outcome: ${input.correlation_id} → ${res.status} ${res.statusText}; dropped`,
          );
        }
      }
    } catch (e) {
      const err = e as Error;
      // AbortError = timeout. ECONNREFUSED = BR offline.
      this.log.error(
        `br-outcome: ${input.correlation_id} POST failed: ${err.name}: ${err.message}; dropped`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertSafeHeaderValue(value: string, name: string): void {
  if (/[\r\n\0-\x1f\x7f]/.test(value)) {
    throw new Error(
      `BrOutcomeReporter: ${name} contains control characters and cannot be used as an HTTP header value`,
    );
  }
}
