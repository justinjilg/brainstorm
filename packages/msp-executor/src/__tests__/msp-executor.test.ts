// MspExecutor unit tests.
//
// Strategy: inject a mock `fetch` so we exercise the executor's
// behaviour (request shape + response translation) without standing up
// a real MSP. The mock records every call and lets each test choose
// what the response looks like.
//
// What's covered (per the wiring brief):
//   1. Happy path: 200 OK with {exit_code,stdout,stderr} faithful round-trip.
//   2. command_id propagation: X-Brainstorm-Command-Id header == ctx.command_id.
//   3. Idempotency-Key parity: Idempotency-Key == X-Brainstorm-Command-Id.
//   4. Service-key auth: Authorization: Bearer {apiKey}.
//   5. JWT auth: Authorization: Bearer {apiKey} (same wire shape).
//   6. 400 IDEMPOTENCY_CORRELATION_MISMATCH → exit 124.
//   7. 403 TENANT_MISMATCH → exit 126.
//   8. 404 → exit 127.
//   9. 5xx → exit 125.
//  10. Timeout (AbortSignal) → exit 124.
//
// Honesty: tests are mock-only. Real-MSP integration testing happens
// later when Justin authorizes the deploy + dttytevx opens a PR with
// the matching MSP-side branch.

import { describe, it, expect } from "vitest";

import { MspExecutor } from "../msp-executor.js";
import type { ToolExecutorContext } from "@brainst0rm/endpoint-stub";

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeMockFetch(
  responder: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const recorded: FetchCall = { url, init: init ?? {} };
    calls.push(recorded);
    return responder(recorded);
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function silentLogger() {
  return { info: () => {}, error: () => {} };
}

function ctx(
  overrides: Partial<ToolExecutorContext> = {},
): ToolExecutorContext {
  return {
    command_id: "11111111-2222-3333-4444-555555555555",
    tool: "msp.list_devices",
    params: { agent_id: "agent-abc" },
    deadline_ms: 30_000,
    correlation_id: "corr-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ...overrides,
  };
}

function headerOf(call: FetchCall, name: string): string | undefined {
  const h = call.init.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  // Headers in our executor are set as a plain object with canonical
  // casing — test exact match first, then a case-insensitive lookup.
  if (name in h) return h[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) return h[k];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("MspExecutor — happy path", () => {
  it("preserves {exit_code,stdout,stderr} from MSP verbatim", async () => {
    const { fetch } = makeMockFetch(() =>
      jsonResponse(200, {
        exit_code: 0,
        stdout: "device list: 12 devices online\n",
        stderr: "",
      }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result).toEqual({
      exit_code: 0,
      stdout: "device list: 12 devices online\n",
      stderr: "",
    });
  });

  it("data-provider response (no exit_code field) → exit 0 + JSON-stringified stdout", async () => {
    const payload = {
      success: true,
      tool: "msp.list_devices",
      data: { devices: [] },
    };
    const { fetch } = makeMockFetch(() => jsonResponse(200, payload));
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Header propagation
// ---------------------------------------------------------------------------

describe("MspExecutor — header contract", () => {
  it("propagates command_id into X-Brainstorm-Command-Id", async () => {
    const { fetch, calls } = makeMockFetch(() =>
      jsonResponse(200, { exit_code: 0, stdout: "", stderr: "" }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const cid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await exec.execute(ctx({ command_id: cid }));
    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0], "X-Brainstorm-Command-Id")).toBe(cid);
  });

  it("sets Idempotency-Key equal to X-Brainstorm-Command-Id", async () => {
    const { fetch, calls } = makeMockFetch(() =>
      jsonResponse(200, { exit_code: 0, stdout: "", stderr: "" }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const cid = "abcdef00-1111-2222-3333-444444444444";
    await exec.execute(ctx({ command_id: cid }));
    const call = calls[0];
    const idemp = headerOf(call, "Idempotency-Key");
    const cmd = headerOf(call, "X-Brainstorm-Command-Id");
    expect(idemp).toBe(cmd);
    expect(idemp).toBe(cid);
  });

  it("posts to /api/v1/god-mode/execute with the expected body", async () => {
    const { fetch, calls } = makeMockFetch(() =>
      jsonResponse(200, { exit_code: 0, stdout: "", stderr: "" }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    await exec.execute(
      ctx({ tool: "msp.process_kill", params: { agent_id: "a1", pid: 9 } }),
    );
    const call = calls[0];
    expect(call.url).toBe("https://brainstormmsp.ai/api/v1/god-mode/execute");
    expect(call.init.method).toBe("POST");
    expect(headerOf(call, "Content-Type")).toBe("application/json");
    const body = JSON.parse(String(call.init.body));
    expect(body).toEqual({
      tool: "msp.process_kill",
      params: { agent_id: "a1", pid: 9 },
      simulate: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Auth modes
// ---------------------------------------------------------------------------

describe("MspExecutor — auth modes", () => {
  it("service_key mode → Authorization: Bearer {apiKey}", async () => {
    const { fetch, calls } = makeMockFetch(() =>
      jsonResponse(200, { exit_code: 0, stdout: "", stderr: "" }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk_service_abc123",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    await exec.execute(ctx());
    expect(headerOf(calls[0], "Authorization")).toBe(
      "Bearer sk_service_abc123",
    );
  });

  it("jwt mode → Authorization: Bearer {jwt}", async () => {
    const { fetch, calls } = makeMockFetch(() =>
      jsonResponse(200, { exit_code: 0, stdout: "", stderr: "" }),
    );
    const jwt = "eyJhbGciOiJIUzI1NiJ9.payload.sig";
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: jwt,
      authMode: "jwt",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    await exec.execute(ctx());
    expect(headerOf(calls[0], "Authorization")).toBe(`Bearer ${jwt}`);
  });
});

// ---------------------------------------------------------------------------
// 6-9. Error mapping
// ---------------------------------------------------------------------------

describe("MspExecutor — error mapping", () => {
  it("400 IDEMPOTENCY_CORRELATION_MISMATCH → exit 124", async () => {
    const { fetch } = makeMockFetch(() =>
      jsonResponse(400, {
        error: {
          code: "IDEMPOTENCY_CORRELATION_MISMATCH",
          message:
            "Idempotency-Key must equal X-Brainstorm-Command-Id when both are present",
        },
      }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result.exit_code).toBe(124);
    expect(result.stderr).toMatch(/header consistency/i);
    expect(result.stderr).toMatch(/Idempotency-Key/);
  });

  it("403 TENANT_MISMATCH → exit 126", async () => {
    const { fetch } = makeMockFetch(() =>
      jsonResponse(403, {
        error: {
          code: "TENANT_MISMATCH",
          message: "Authenticated tenant does not match request tenant",
        },
      }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result.exit_code).toBe(126);
    expect(result.stderr).toMatch(/auth error/i);
    expect(result.stderr).toMatch(/TENANT_MISMATCH/);
  });

  it("401 UNAUTHORIZED → exit 126", async () => {
    const { fetch } = makeMockFetch(() =>
      jsonResponse(401, {
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result.exit_code).toBe(126);
  });

  it("404 NOT_FOUND → exit 127", async () => {
    const { fetch } = makeMockFetch(() =>
      jsonResponse(404, {
        error: { code: "NOT_FOUND", message: "Unknown tool: msp.nonexistent" },
      }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx({ tool: "msp.nonexistent" }));
    expect(result.exit_code).toBe(127);
    expect(result.stderr).toMatch(/tool unknown/i);
  });

  it("5xx → exit 125 with body forwarded for diagnosis", async () => {
    const serverBody = "Internal Server Error: postgres connection refused";
    const { fetch } = makeMockFetch(
      () => new Response(serverBody, { status: 503 }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result.exit_code).toBe(125);
    expect(result.stderr).toContain(serverBody);
    expect(result.stderr).toMatch(/server error \(503\)/);
  });
});

// ---------------------------------------------------------------------------
// 10. Timeout / transport
// ---------------------------------------------------------------------------

describe("MspExecutor — transport", () => {
  it("AbortSignal timeout → exit 124", async () => {
    // Use a real AbortSignal to drive the abort: when the signal fires,
    // throw an AbortError to mimic what fetch would do.
    const fetchImpl = (async (
      _input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal) {
          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }
          signal.addEventListener("abort", () => {
            reject(makeAbortError());
          });
        }
        // never resolve otherwise — wait for abort.
      });
    }) as unknown as typeof fetch;

    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      // Tight default timeout so the test runs fast.
      defaultTimeoutMs: 50,
      fetch: fetchImpl,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx({ deadline_ms: 50 }));
    expect(result.exit_code).toBe(124);
    expect(result.stderr).toMatch(/transport error/i);
  });

  it("network failure (TypeError) → exit 124", async () => {
    const { fetch } = makeMockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result.exit_code).toBe(124);
    expect(result.stderr).toMatch(/transport error/i);
    expect(result.stderr).toMatch(/fetch failed/);
  });
});

describe("MspExecutor — Codex-review hardening (round 1)", () => {
  it("4xx that is neither idempotency/auth/404 → exit 1 (NOT 125)", async () => {
    // 400 CHANGESET_REQUIRED is the canonical example: it's MSP saying
    // "this tool needs a ChangeSet"; operators must read it as
    // tool-rejection, not as a 5xx server failure.
    const { fetch } = makeMockFetch(() =>
      jsonResponse(400, {
        error: { code: "CHANGESET_REQUIRED", message: "needs ChangeSet" },
      }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/CHANGESET_REQUIRED/);
  });

  it("ctx.deadline_ms <= 0 fails fast as exit 124 without firing fetch", async () => {
    const calls: number[] = [];
    const { fetch } = makeMockFetch(() => {
      calls.push(1);
      return jsonResponse(200, { exit_code: 0 });
    });
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx({ deadline_ms: 0 }));
    expect(result.exit_code).toBe(124);
    expect(result.stderr).toMatch(/deadline expired/i);
    expect(calls.length).toBe(0); // fetch must NOT be called
  });

  it("constructor rejects non-positive defaultTimeoutMs", () => {
    expect(
      () =>
        new MspExecutor({
          baseUrl: "https://brainstormmsp.ai",
          apiKey: "sk-test",
          authMode: "service_key",
          tenantId: "tenant-x",
          defaultTimeoutMs: 0,
        }),
    ).toThrow(/positive finite/);
    expect(
      () =>
        new MspExecutor({
          baseUrl: "https://brainstormmsp.ai",
          apiKey: "sk-test",
          authMode: "service_key",
          tenantId: "tenant-x",
          defaultTimeoutMs: -1,
        }),
    ).toThrow(/positive finite/);
  });

  it("200 with non-JSON body → exit 0 with raw stdout (graceful)", async () => {
    const { fetch } = makeMockFetch(
      () =>
        new Response("plain text body", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("plain text body");
  });

  it("200 with malformed exit_code (string '1') → exit 124 (fail closed)", async () => {
    // Without this guard the body is treated as a data-provider object
    // and the malformed exit gets silently rewritten to 0.
    const { fetch } = makeMockFetch(() =>
      jsonResponse(200, { exit_code: "1", stderr: "tool failed" }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const result = await exec.execute(ctx());
    expect(result.exit_code).toBe(124);
    expect(result.stderr).toMatch(/malformed/i);
    expect(result.stderr).toMatch(/exit_code/);
  });

  it("forwards ctx.correlation_id as X-Correlation-Id header", async () => {
    // Per protocol §13 + 12xnwqbb federation design — every outbound
    // hop from the endpoint forwards the correlation id so BR can join
    // cross-product audit chains.
    const { fetch, calls } = makeMockFetch(() =>
      jsonResponse(200, { exit_code: 0, stdout: "ok", stderr: "" }),
    );
    const exec = new MspExecutor({
      baseUrl: "https://brainstormmsp.ai",
      apiKey: "sk-test",
      authMode: "service_key",
      tenantId: "tenant-x",
      fetch,
      logger: silentLogger(),
    });
    const corr = "corr-cross-product-audit-trace-12345";
    await exec.execute(ctx({ correlation_id: corr }));
    expect(calls.length).toBe(1);
    expect(headerOf(calls[0]!, "X-Correlation-Id")).toBe(corr);
  });
});

function makeAbortError(): Error {
  // DOMException is available in Node 22; use its name "AbortError" so
  // any handler that switches on err.name treats it as a real abort.
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}
