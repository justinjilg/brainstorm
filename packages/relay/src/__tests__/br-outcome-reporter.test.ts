// BrOutcomeReporter tests.
//
// All tests use injected fetch implementations to avoid real network IO.
// We verify:
//   - happy path: correct URL, headers (Idempotency-Key, Content-Type,
//     Authorization), body shape
//   - fire-and-forget survives network errors (no throw, log only)
//   - timeout is respected (AbortController fires)
//   - 404 is logged at info-level (BR not deployed yet — expected)
//   - inflightCount tracks pending POSTs

import { describe, it, expect, vi } from "vitest";
import {
  BrOutcomeReporter,
  type DispatchOutcomeReport,
} from "../br-outcome-reporter.js";

function makeReport(
  overrides: Partial<DispatchOutcomeReport> = {},
): DispatchOutcomeReport {
  return {
    agentId: "ep-1",
    correlation_id: "corr-abc",
    outcome: "completed",
    started_at: "2026-04-27T12:00:00.000Z",
    completed_at: "2026-04-27T12:00:01.500Z",
    duration_ms: 1500,
    success: true,
    payload_size_in: 100,
    payload_size_out: 200,
    ...overrides,
  };
}

describe("BrOutcomeReporter — happy path", () => {
  it("POSTs to the correct URL with Idempotency-Key and locked body shape", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      apiKey: "br-key-test",
      fetch: fakeFetch,
    });

    await reporter.report(makeReport());

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      "https://api.brainstormrouter.com/v1/agents/ep-1/dispatch-outcomes",
    );
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toBe("corr-abc");
    expect(headers.Authorization).toBe("Bearer br-key-test");

    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      correlation_id: "corr-abc",
      outcome: "completed",
      started_at: "2026-04-27T12:00:00.000Z",
      completed_at: "2026-04-27T12:00:01.500Z",
      duration_ms: 1500,
      success: true,
      payload_size_in: 100,
      payload_size_out: 200,
    });
    expect(body.error_class).toBeUndefined();
  });

  it("includes error_class only when supplied", async () => {
    let captured: string | undefined;
    const fakeFetch: typeof fetch = (_url, init) => {
      captured = String(init?.body);
      return Promise.resolve(new Response("{}", { status: 202 }));
    };
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      fetch: fakeFetch,
    });
    await reporter.report(
      makeReport({
        outcome: "failed",
        success: false,
        error_class: "SANDBOX_TOOL_ERROR",
      }),
    );
    expect(captured).toBeDefined();
    expect(JSON.parse(captured!).error_class).toBe("SANDBOX_TOOL_ERROR");
  });

  it("URL-encodes the agentId path segment", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = (url) => {
      calls.push(String(url));
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      fetch: fakeFetch,
    });
    await reporter.report(makeReport({ agentId: "ep with spaces" }));
    expect(calls[0]).toContain("/agents/ep%20with%20spaces/");
  });
});

describe("BrOutcomeReporter — header safety", () => {
  it("throws before POST when correlation_id contains control characters", () => {
    const fakeFetch = vi.fn<typeof fetch>();
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      fetch: fakeFetch,
    });

    expect(() =>
      reporter.report(makeReport({ correlation_id: "corr\r\nInjected: x" })),
    ).toThrow(/control characters/);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe("BrOutcomeReporter — fire-and-forget survives failures", () => {
  it("does not throw when fetch rejects (network error)", async () => {
    const errors: string[] = [];
    const fakeFetch: typeof fetch = () =>
      Promise.reject(new Error("ECONNREFUSED 127.0.0.1:443"));
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      fetch: fakeFetch,
      logger: {
        info: () => {},
        error: (m) => errors.push(m),
      },
    });

    // Must not throw
    await expect(reporter.report(makeReport())).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/POST failed/);
    expect(errors[0]).toMatch(/ECONNREFUSED/);
  });

  it("does not throw on non-2xx (e.g. 500); logs at error", async () => {
    const errors: string[] = [];
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response("oops", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      fetch: fakeFetch,
      logger: { info: () => {}, error: (m) => errors.push(m) },
    });
    await expect(reporter.report(makeReport())).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/500/);
  });

  it("logs 404 at info level (BR endpoint not deployed yet — expected)", async () => {
    const infos: string[] = [];
    const errors: string[] = [];
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(new Response("not found", { status: 404 }));
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      fetch: fakeFetch,
      logger: {
        info: (m) => infos.push(m),
        error: (m) => errors.push(m),
      },
    });
    await reporter.report(makeReport());
    expect(infos.some((m) => m.includes("404"))).toBe(true);
    expect(errors.length).toBe(0);
  });

  it("aborts after timeoutMs when fetch hangs", async () => {
    const errors: string[] = [];
    const fakeFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        // Never resolve normally — only reject on abort.
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      fetch: fakeFetch,
      timeoutMs: 30,
      logger: { info: () => {}, error: (m) => errors.push(m) },
    });
    const t0 = Date.now();
    await reporter.report(makeReport());
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/AbortError|aborted/i);
  });
});

describe("BrOutcomeReporter — observability", () => {
  it("inflightCount reaches 0 after a settled report", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(new Response("{}", { status: 200 }));
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      fetch: fakeFetch,
    });
    const p = reporter.report(makeReport());
    expect(reporter.inflightCount()).toBe(1);
    await p;
    expect(reporter.inflightCount()).toBe(0);
  });

  it("strips trailing slash from baseUrl", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = (url) => {
      calls.push(String(url));
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com/",
      fetch: fakeFetch,
    });
    await reporter.report(makeReport());
    expect(calls[0]).toBe(
      "https://api.brainstormrouter.com/v1/agents/ep-1/dispatch-outcomes",
    );
  });

  it("omits Authorization header when no apiKey is configured", async () => {
    const seen: Record<string, string>[] = [];
    const fakeFetch: typeof fetch = (_url, init) => {
      seen.push(init?.headers as Record<string, string>);
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const reporter = new BrOutcomeReporter({
      baseUrl: "https://api.brainstormrouter.com",
      fetch: fakeFetch,
    });
    await reporter.report(makeReport());
    expect(seen[0].Authorization).toBeUndefined();
  });
});
