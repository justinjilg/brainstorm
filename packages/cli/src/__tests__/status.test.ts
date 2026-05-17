import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __test } from "../commands/status.js";

const { fetchProductStatus, formatStatusBadge, PRODUCTS } = __test;

describe("brainstorm status", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  it("known products array covers all 5", () => {
    expect(PRODUCTS.map((p) => p.id).sort()).toEqual([
      "br",
      "gtm",
      "msp",
      "shield",
      "vm",
    ]);
  });

  it("MSP and VM declare hasEdgeProtocol; others do not", () => {
    expect(PRODUCTS.find((p) => p.id === "msp")?.hasEdgeProtocol).toBe(true);
    expect(PRODUCTS.find((p) => p.id === "vm")?.hasEdgeProtocol).toBe(true);
    expect(PRODUCTS.find((p) => p.id === "br")?.hasEdgeProtocol).toBe(false);
    expect(PRODUCTS.find((p) => p.id === "gtm")?.hasEdgeProtocol).toBe(false);
    expect(PRODUCTS.find((p) => p.id === "shield")?.hasEdgeProtocol).toBe(
      false,
    );
  });

  it("reports unreachable when fetch fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const target = PRODUCTS[0]!;
    const status = await fetchProductStatus(target);
    expect(status.reachable).toBe(false);
    expect(status.error).toContain("ECONNREFUSED");
    expect(status.latencyMs).toBe(null);
  });

  it("parses healthy /health response", async () => {
    process.env.BRAINSTORM_MSP_API_KEY = "br_live_test";
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "healthy",
              product: "msp",
              version: "1.0.0",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (u.endsWith("/api/v1/god-mode/tools")) {
        return Promise.resolve(
          new Response(JSON.stringify({ tools: [{ name: "msp.foo" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (u.endsWith("/api/v1/edge/heartbeat")) {
        return Promise.resolve(new Response("{}", { status: 400 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as typeof globalThis.fetch;

    const target = PRODUCTS.find((p) => p.id === "msp")!;
    const status = await fetchProductStatus(target);
    expect(status.reachable).toBe(true);
    expect(status.healthStatus).toBe("healthy");
    expect(status.product).toBe("msp");
    expect(status.version).toBe("1.0.0");
    expect(status.toolCount).toBe(1);
    expect(status.edgeProtocolImplemented).toBe(true); // 400 != 404 → route exists
  });

  it("flags edge protocol as missing when probe returns 404", async () => {
    process.env.BRAINSTORM_VM_API_KEY = "k";
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: "healthy" }), { status: 200 }),
        );
      }
      if (u.endsWith("/api/v1/edge/heartbeat")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (u.endsWith("/api/v1/god-mode/tools")) {
        return Promise.resolve(
          new Response(JSON.stringify({ tools: [] }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }) as typeof globalThis.fetch;

    const target = PRODUCTS.find((p) => p.id === "vm")!;
    const status = await fetchProductStatus(target);
    expect(status.edgeProtocolImplemented).toBe(false);
  });

  it("skips tools fetch when API key is unset", async () => {
    delete process.env.BRAINSTORM_GTM_API_KEY;
    const fetchSpy = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;
    const target = PRODUCTS.find((p) => p.id === "gtm")!;
    const status = await fetchProductStatus(target);
    expect(status.apiKeyConfigured).toBe(false);
    expect(status.toolCount).toBe(null);
    // /health was called; god-mode/tools was NOT
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.endsWith("/health"))).toBe(true);
    expect(calls.some((c) => c.endsWith("/api/v1/god-mode/tools"))).toBe(false);
  });

  it("status badge formats correctly", () => {
    expect(
      formatStatusBadge({
        id: "x",
        displayName: "X",
        baseUrl: "",
        apiKeyConfigured: true,
        reachable: true,
        healthStatus: "healthy",
        product: null,
        version: null,
        toolCount: null,
        edgeProtocolImplemented: null,
        latencyMs: 10,
        error: null,
      }),
    ).toBe("✓ ok");
    expect(
      formatStatusBadge({
        id: "x",
        displayName: "X",
        baseUrl: "",
        apiKeyConfigured: true,
        reachable: false,
        healthStatus: null,
        product: null,
        version: null,
        toolCount: null,
        edgeProtocolImplemented: null,
        latencyMs: null,
        error: "boom",
      }),
    ).toBe("✗ unreachable");
  });
});
