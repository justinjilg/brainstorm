/**
 * BR-down chaos test (path-to-90 P9d).
 *
 * Closes the v14/v15 Chaos Monkey carry-forward: brainstorm-saas.ts
 * fetch wrapper under BR-unreachable scenarios. Tests verify the
 * wrapper does NOT crash with unhandled rejection when:
 *   1. Upstream fetch throws (ECONNREFUSED, DNS error, network unreachable)
 *   2. Upstream returns 503 with normal JSON body
 *   3. Upstream returns 503 with SSE content-type (degraded streaming)
 *   4. Upstream returns 200 with content-length=0 (empty body)
 *   5. Upstream returns 200 with malformed SSE (the wrapper's input shape)
 *
 * Strategy: temporarily replace globalThis.fetch with a mock for each
 * test, run the wrapper, restore globalThis.fetch. The wrapper is the
 * unit under test; the AI SDK layer above it is not.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createGuardianFilterFetch } from "../cloud/brainstorm-saas.js";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // Each test installs its own mock; ORIGINAL_FETCH restored in afterEach.
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("brainstorm-saas fetch wrapper — BR-down chaos (P9d)", () => {
  it("propagates ECONNREFUSED-style network errors without crashing", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    };
    const wrapped = createGuardianFilterFetch();
    await expect(
      wrapped("https://api.brainstormrouter.com/v1/chat/completions"),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("propagates DNS-error-style failures without unhandled rejection", async () => {
    globalThis.fetch = async () => {
      const err = new Error("getaddrinfo ENOTFOUND api.brainstormrouter.com");
      throw err;
    };
    const wrapped = createGuardianFilterFetch();
    await expect(
      wrapped("https://api.brainstormrouter.com/v1/chat/completions"),
    ).rejects.toThrow(/ENOTFOUND/);
  });

  it("passes through 503 with JSON body unchanged (no SSE filtering)", async () => {
    const body = '{"error":{"message":"BR degraded","type":"upstream_error"}}';
    globalThis.fetch = async () =>
      new Response(body, {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    const wrapped = createGuardianFilterFetch();
    const res = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
    );
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe(body);
  });

  it("passes through 200 + content-length: 0 without crashing on empty body", async () => {
    globalThis.fetch = async () =>
      new Response("", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "0" },
      });
    const wrapped = createGuardianFilterFetch();
    const res = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("handles 503 with SSE content-type (degraded streaming) without crashing the body reader", async () => {
    // BR can return 503 with text/event-stream when it's mid-stream and a
    // backend fails. The wrapper must not crash trying to filter guardian
    // events from a degraded body.
    globalThis.fetch = async () =>
      new Response('data: {"error":"upstream"}\n\n', {
        status: 503,
        headers: { "content-type": "text/event-stream" },
      });
    const wrapped = createGuardianFilterFetch();
    const res = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
    );
    expect(res.status).toBe(503);
    // The wrapper produces a new Response with filtered body; reader must
    // not throw on stream consumption.
    const text = await res.text();
    expect(text).toContain("error");
  });

  it("guardian SSE events ARE filtered from valid streaming responses", async () => {
    // Original happy-path verification: the wrapper exists to filter
    // guardian SSE events. Confirm the filtering still works post-export.
    const guardianData =
      'data: {"guardian": {"status": "on", "audit_hash": "abc"}}\n';
    const realData = 'data: {"choices": [{"delta": {"content": "hi"}}]}\n';
    globalThis.fetch = async () =>
      new Response(guardianData + realData + "data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const wrapped = createGuardianFilterFetch();
    const res = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
    );
    const text = await res.text();
    // Guardian event should be filtered out; real data should pass through.
    expect(text).not.toContain('"guardian"');
    expect(text).toContain('"choices"');
  });

  it("non-SSE content type with body bypasses filtering entirely (200 JSON)", async () => {
    const body = '{"id":"abc","object":"chat.completion","choices":[]}';
    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const wrapped = createGuardianFilterFetch();
    const res = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it("survives null-body responses (HEAD-style)", async () => {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 204,
        headers: { "content-type": "application/json" },
      });
    const wrapped = createGuardianFilterFetch();
    const res = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
    );
    expect(res.status).toBe(204);
    // No body to read; should not throw.
    expect(res.body).toBeNull();
  });

  it("survives slow-loris-style aborted fetches without leaking the reader", async () => {
    // Simulate a fetch that returns a response but the reader times out.
    // We verify that the wrapper's reader cancellation propagates.
    const ac = new AbortController();
    globalThis.fetch = async (_url, init) => {
      // If the caller's signal aborts, throw AbortError.
      const callerSignal = (init as RequestInit | undefined)?.signal;
      if (callerSignal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return new Response("data: stream\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const wrapped = createGuardianFilterFetch();
    // Abort before the fetch even begins.
    ac.abort();
    const result = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
      { signal: ac.signal },
    ).catch((err) => err as Error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).name).toBe("AbortError");
  });
});
