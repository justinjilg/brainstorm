import { describe, expect, it, afterEach, vi } from "vitest";
import { createGuardianFilterFetch } from "../cloud/brainstorm-saas.js";
import type { BrEnvelope } from "../cloud/br-envelope.js";

const ORIGINAL_FETCH = globalThis.fetch;

const BR_HEADERS = {
  "content-type": "application/json",
  "x-request-id": "req-provider-envelope-001",
  "x-br-actual-cost": "0.000037",
  "x-br-audit-hash":
    "590439b4451f67ea3ce43942edd66f831b1bd3ffd2c625f1e78898196314c285",
  "x-br-build": "1b3c127",
  "x-br-envelope": "audit",
  "x-br-estimated-cost": "0.00004",
  "x-br-route-confidence": "0.42",
  "x-br-route-reason": "auto",
  "x-br-routed-model": "deepseek/deepseek-chat",
  "x-br-selection-method": "thompson",
};

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("brainstorm-saas provider envelope contract", () => {
  it("captures typed BR envelope metadata without altering the response body", async () => {
    const seen: BrEnvelope[] = [];
    const body = JSON.stringify({
      choices: [{ message: { content: "pong" } }],
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: BR_HEADERS,
      });
    }) as typeof fetch;

    const wrapped = createGuardianFilterFetch((envelope) => {
      seen.push(envelope);
    });
    const res = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({ model: "auto" }),
      },
    );
    await flushMicrotasks();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      requestId: "req-provider-envelope-001",
      build: "1b3c127",
      envelope: "audit",
      routedModel: "deepseek/deepseek-chat",
      actualCost: 0.000037,
      estimatedCost: 0.00004,
      routeReason: "auto",
      selectionMethod: "thompson",
      routeConfidence: 0.42,
      auditHash:
        "590439b4451f67ea3ce43942edd66f831b1bd3ffd2c625f1e78898196314c285",
      unknownHeaders: [],
    });
  });

  it("does not let listener errors break the provider fetch path", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: BR_HEADERS,
      });
    }) as typeof fetch;
    const wrapped = createGuardianFilterFetch(() => {
      throw new Error("listener broke");
    });

    const res = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
    );
    await flushMicrotasks();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(consoleError).toHaveBeenCalledWith(
      "[brainstorm-saas] envelope listener threw:",
      expect.any(Error),
    );
  });

  it("filters guardian SSE events while preserving model output frames", async () => {
    const seen: BrEnvelope[] = [];
    const guardianData =
      'event: guardian\ndata: {"guardian": {"status": "on", "audit_hash": "abc"}}\n\n';
    const modelData =
      'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n';
    globalThis.fetch = vi.fn(async () => {
      return new Response(guardianData + modelData, {
        status: 200,
        headers: {
          ...BR_HEADERS,
          "content-type": "text/event-stream",
        },
      });
    }) as typeof fetch;

    const wrapped = createGuardianFilterFetch((envelope) => {
      seen.push(envelope);
    });
    const res = await wrapped(
      "https://api.brainstormrouter.com/v1/chat/completions",
    );
    const text = await res.text();
    await flushMicrotasks();

    expect(text).toContain("pong");
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"guardian"');
    expect(seen).toHaveLength(1);
    expect(seen[0].requestId).toBe("req-provider-envelope-001");
  });
});
