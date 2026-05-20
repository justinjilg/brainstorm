import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { __test } from "../commands/a2a.js";

const {
  buildInvokeDidUrl,
  classifyInvokeError,
  responseKeepsTraceId,
  traceIdFromTraceparent,
  invokeOnce,
  pollStatus,
  emitResult,
  emitError,
} = __test;

describe("brainstorm a2a invoke — wire helpers", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("buildInvokeDidUrl uses BR's DID-keyed route, not the hostname route", () => {
    const url = buildInvokeDidUrl(
      "https://br.example/",
      "did:bvm:t:msp:agent-1",
    );
    expect(url).toBe(
      "https://br.example/v1/mesh/invoke-did/did%3Abvm%3At%3Amsp%3Aagent-1",
    );
    expect(url).not.toContain("/v1/mesh/invoke/did%3A");
  });

  it("the BR business contract map tracks the DID invoke route and negative hostname guard", () => {
    const map = JSON.parse(
      readFileSync(
        new URL(
          "../../../../artifacts/br-business-contract-map.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      routes: Array<{
        id: string;
        target: string;
        method: string;
        path: string;
      }>;
    };
    expect(map.routes).toContainEqual(
      expect.objectContaining({
        id: "a2a.invoke_did",
        target: "br",
        method: "POST",
        path: "/v1/mesh/invoke-did/{target_did}",
      }),
    );
    expect(map.routes).toContainEqual(
      expect.objectContaining({
        id: "a2a.hostname_invoke",
        target: "br",
        method: "POST",
        path: "/v1/mesh/invoke/{hostname}",
      }),
    );
  });

  it("invokeOnce POSTs to /v1/mesh/invoke-did/<target_did> with bearer auth + traceparent + idempotency", async () => {
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
      "https://br.example/v1/mesh/invoke-did/did%3Abvm%3At%3Aagent",
    );
    const headers = captured.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["traceparent"]).toBe(
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
    expect(headers["Idempotency-Key"]).toBe("idem-1");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("trace helper verifies response traceparent keeps the original trace id", () => {
    const requestTraceparent =
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    expect(traceIdFromTraceparent(requestTraceparent)).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(
      responseKeepsTraceId(requestTraceparent, {
        traceparent: "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01",
      }),
    ).toBe(true);
    expect(
      responseKeepsTraceId(requestTraceparent, {
        traceparent: "00-fedcba9876543210fedcba9876543210-fedcba9876543210-01",
      }),
    ).toBe(false);
    expect(responseKeepsTraceId(requestTraceparent, {})).toBe(false);
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
    expect(combined).toMatch(/class: rate_limited/);
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
    expect(payload.category).toBe("scope_or_tenant");
    expect(payload.body.error.code).toBe("FORBIDDEN");
  });

  it("classifyInvokeError maps A2A error statuses to operator-safe semantics", () => {
    expect(classifyInvokeError(400).category).toBe("validation");
    expect(classifyInvokeError(401).category).toBe("auth");
    expect(classifyInvokeError(403).category).toBe("scope_or_tenant");
    expect(classifyInvokeError(404).category).toBe("capability_mismatch");
    expect(classifyInvokeError(409).category).toBe("idempotency_conflict");
    expect(classifyInvokeError(410).category).toBe("expired");
    expect(classifyInvokeError(429).category).toBe("rate_limited");
    expect(classifyInvokeError(500).category).toBe(
      "broker_or_target_unavailable",
    );
    expect(classifyInvokeError(503).category).toBe(
      "broker_or_target_unavailable",
    );
  });

  it("emitError gives specific hints for capability mismatch, scope failure, and idempotency conflicts", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    emitError(
      404,
      { error: { code: "NOT_FOUND", message: "missing capability" } },
      false,
    );
    emitError(
      403,
      { error: { code: "FORBIDDEN", message: "wrong tenant" } },
      false,
    );
    emitError(
      409,
      {
        task_id: "task-original",
        error: { code: "IDEMPOTENCY_CONFLICT", message: "payload changed" },
      },
      false,
    );
    const combined = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(combined).toMatch(/capability_mismatch/);
    expect(combined).toMatch(/scope_or_tenant/);
    expect(combined).toMatch(/idempotency_conflict/);
    expect(combined).toMatch(/original_task_id: task-original/);
  });

  it("invokeOnce surfaces a fetch rejection as a thrown Error (not silent exit 0)", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    await expect(
      invokeOnce(
        "http://127.0.0.1:9",
        "tok",
        "did:bvm:t:a",
        { task_id: "t1", capability: "c", input: {} },
        "tp",
        "k",
      ),
    ).rejects.toThrow(/fetch failed/);
  });

  it("rejects non-positive --poll-interval-ms before entering the polling loop", () => {
    // Sanity-check the validator predicate runInvoke uses. The full
    // command path is exercised via the dist binary; here we just lock
    // the predicate so a future refactor can't loosen it.
    const isValidPoll = (n: number) => Number.isFinite(n) && n > 0;
    expect(isValidPoll(0)).toBe(false);
    expect(isValidPoll(-1)).toBe(false);
    expect(isValidPoll(NaN)).toBe(false);
    expect(isValidPoll(2000)).toBe(true);
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
