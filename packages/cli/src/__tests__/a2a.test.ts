import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __test } from "../commands/a2a.js";

const { invokeOnce, pollStatus, emitResult, emitError } = __test;

describe("brainstorm a2a invoke — wire helpers", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("invokeOnce POSTs to /v1/mesh/invoke/<target_did> with bearer auth + traceparent + idempotency", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = (async (url: any, init: any) => {
      captured.url = url;
      captured.init = init;
      return new Response(
        JSON.stringify({ task_id: "t1", output: { ok: true } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const res = await invokeOnce(
      "https://br.example",
      "tok",
      "did:bvm:t:agent",
      {
        task_id: "t1",
        capability: "agent.test",
        input: { hi: "x" },
        deadline_iso: "2026-05-17T00:00:00Z",
      },
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      "idem-1",
    );

    expect(res.status).toBe(200);
    expect(captured.url).toBe(
      "https://br.example/v1/mesh/invoke/did%3Abvm%3At%3Aagent",
    );
    const headers = captured.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["traceparent"]).toBe(
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
    expect(headers["Idempotency-Key"]).toBe("idem-1");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("invokeOnce returns non-JSON body as text for 5xx pages", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>500</html>", {
        status: 502,
      })) as typeof globalThis.fetch;
    const res = await invokeOnce(
      "https://br.example",
      "tok",
      "did:bvm:t:agent",
      { task_id: "t1", capability: "c", input: {} },
      "tp",
      "k",
    );
    expect(res.status).toBe(502);
    expect(res.body).toBe("<html>500</html>");
  });

  it("pollStatus follows an absolute URL when provided", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: any) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ task_id: "t1", output: { done: true } }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    const res = await pollStatus(
      "https://br.example",
      "tok",
      "https://elsewhere/v1/mesh/task/t1",
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://elsewhere/v1/mesh/task/t1"]);
  });

  it("pollStatus prepends baseUrl when status_url is path-relative", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: any) => {
      seen.push(String(url));
      return new Response(JSON.stringify({}), { status: 202 });
    }) as typeof globalThis.fetch;

    await pollStatus("https://br.example/", "tok", "/v1/mesh/task/t1");
    expect(seen).toEqual(["https://br.example/v1/mesh/task/t1"]);
  });

  it("emitError surfaces error.code + retry_after_seconds on RATE_LIMITED", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    emitError(
      429,
      {
        success: false,
        error: { code: "RATE_LIMITED", message: "slow down" },
        retry_after_seconds: 7,
      },
      false,
    );
    const combined = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(combined).toMatch(/HTTP 429/);
    expect(combined).toMatch(/RATE_LIMITED/);
    expect(combined).toMatch(/retry_after_seconds: 7/);
  });

  it("emitError --json prints the structured envelope without human framing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    emitError(
      403,
      { success: false, error: { code: "FORBIDDEN", message: "no" } },
      true,
    );
    expect(errSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(payload.status).toBe(403);
    expect(payload.body.error.code).toBe("FORBIDDEN");
  });

  it("emitResult --json prints the task envelope verbatim", () => {
    const outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitResult(
      { task_id: "t1", output: { ok: 1 }, evidence_envelope_hash: "h" },
      true,
    );
    const payload = JSON.parse(outSpy.mock.calls[0][0] as string);
    expect(payload.task_id).toBe("t1");
    expect(payload.evidence_envelope_hash).toBe("h");
  });
});
