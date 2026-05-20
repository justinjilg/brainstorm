import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveChangeSet } from "../changeset.js";
import { ProductConnector } from "../product-connector.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("ProductConnector", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, TEST_PRODUCT_KEY: "test-key" };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("quarantines unsafe schemas instead of widening them to z.any()", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        tools: [
          {
            name: "safe.search",
            domain: "search",
            product: "test",
            description: "Safe search",
            parameters: {
              type: "object",
              required: ["query"],
              properties: { query: { type: "string" } },
            },
            risk_level: "read_only",
            requires_changeset: false,
          },
          {
            name: "unsafe.array",
            domain: "search",
            product: "test",
            description: "Unsafe array",
            parameters: {
              type: "object",
              properties: { values: { type: "array" } },
            },
            risk_level: "read_only",
            requires_changeset: false,
          },
        ],
      }),
    ) as typeof fetch;

    const connector = new ProductConnector("test", {
      enabled: true,
      baseUrl: "https://product.example",
      apiKeyName: "TEST_PRODUCT_KEY",
      tenantId: "tenant-1",
    });

    await connector.initialize();

    expect(connector.getTools().map((tool) => tool.name)).toEqual([
      "safe_search",
    ]);
  });

  it("sends tenant, trace, and idempotency binding on direct execute", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          tools: [
            {
              name: "system.inspect",
              domain: "system",
              product: "test",
              description: "Inspect",
              parameters: {
                type: "object",
                required: ["target"],
                properties: { target: { type: "string" } },
              },
              risk_level: "read_only",
              requires_changeset: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    globalThis.fetch = fetch as typeof globalThis.fetch;

    const connector = new ProductConnector("test", {
      enabled: true,
      baseUrl: "https://product.example",
      apiKeyName: "TEST_PRODUCT_KEY",
      tenantId: "tenant-1",
    });
    await connector.initialize();

    const result = await connector.getTools()[0].execute?.({ target: "fleet" });

    expect(result).toEqual({ ok: true });
    const [, init] = fetch.mock.calls[1];
    expect(init?.headers).toMatchObject({
      "X-Brainstorm-Tenant-Id": "tenant-1",
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      tool: "system.inspect",
      params: { target: "fleet" },
      simulate: false,
      tenant_id: "tenant-1",
    });
    expect(body.trace_id).toMatch(/^trace_/);
    expect(body.idempotency_key).toContain("test:system.inspect:execute:");
  });

  it("binds approved ChangeSet execution to the prior simulation token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          tools: [
            {
              name: "user.disable",
              domain: "user",
              product: "test",
              description: "Disable user",
              parameters: {
                type: "object",
                required: ["user_id"],
                properties: { user_id: { type: "string" } },
              },
              risk_level: "high",
              requires_changeset: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          simulation_token: "sim-token-1",
          simulation: {
            success: true,
            statePreview: { disabled: true },
            cascades: [],
            constraints: [],
            estimatedDuration: "1s",
          },
          description: "Disable user",
          changes: [
            {
              system: "test",
              entity: "user:u-1",
              operation: "update",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ message: "executed" }));
    globalThis.fetch = fetch as typeof globalThis.fetch;

    const connector = new ProductConnector("test", {
      enabled: true,
      baseUrl: "https://product.example",
      apiKeyName: "TEST_PRODUCT_KEY",
      tenantId: "tenant-1",
    });
    await connector.initialize();

    const draft = (await connector.getTools()[0].execute?.({
      user_id: "u-1",
    })) as { changeset_id: string };
    const approved = await approveChangeSet(draft.changeset_id);

    expect(approved.success).toBe(true);
    const simulateBody = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    const executeBody = JSON.parse(String(fetch.mock.calls[2][1]?.body));
    expect(simulateBody).toMatchObject({
      simulate: true,
      tenant_id: "tenant-1",
    });
    expect(executeBody).toMatchObject({
      simulate: false,
      tenant_id: "tenant-1",
      changeset_id: draft.changeset_id,
      simulation_token: "sim-token-1",
    });
    expect(executeBody.trace_id).toBe(simulateBody.trace_id);
    expect(executeBody.idempotency_key).toContain("test:user.disable:execute:");
  });

  it("refuses to create an unbound ChangeSet when simulation omits a token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          tools: [
            {
              name: "user.disable",
              domain: "user",
              product: "test",
              description: "Disable user",
              parameters: {
                type: "object",
                required: ["user_id"],
                properties: { user_id: { type: "string" } },
              },
              risk_level: "high",
              requires_changeset: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          simulation: {
            success: true,
            statePreview: {},
            cascades: [],
            constraints: [],
            estimatedDuration: "1s",
          },
        }),
      );
    globalThis.fetch = fetch as typeof globalThis.fetch;

    const connector = new ProductConnector("test", {
      enabled: true,
      baseUrl: "https://product.example",
      apiKeyName: "TEST_PRODUCT_KEY",
      tenantId: "tenant-1",
    });
    await connector.initialize();

    await expect(
      connector.getTools()[0].execute?.({ user_id: "u-1" }),
    ).resolves.toEqual({
      error:
        "Product simulation did not return a simulation_token; refusing to create an unbound ChangeSet.",
    });
  });
});
