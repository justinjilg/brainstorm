// @ts-nocheck — autonomously generated, ConnectorConfig shape simplified
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VMClient } from "../client.js";

describe("VMClient", () => {
  let client: VMClient;
  const baseUrl = "http://localhost:9090";

  beforeEach(() => {
    // Reset fetch mock
    vi.stubGlobal("fetch", vi.fn());

    // Set API key for tests
    process.env._GM_VM_KEY = "test-key-123";

    client = new VMClient({
      name: "BrainstormVM",
      baseUrl,
      apiKeyName: "TEST_VM_KEY",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env._GM_VM_KEY;
  });

  it("should perform a health check successfully", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ok" }),
    } as Response);

    const result = await client.healthCheck();

    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/health`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key-123",
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should handle missing API key gracefully", async () => {
    delete process.env._GM_VM_KEY;
    delete process.env.TEST_VM_KEY;

    const result = await client.listVMs();
    expect(result).toHaveProperty("error");
    expect(result.error).toContain("No API key for BrainstormVM");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should create a VM", async () => {
    const mockResponse = { id: "vm-123", status: "creating" };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const spec = {
      name: "test-vm",
      vcpus: 4,
      memoryMb: 8192,
      diskGb: 50,
    };

    const result = await client.createVM(spec);

    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/resources`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(spec),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it("should migrate a VM", async () => {
    const mockResponse = { id: "vm-123", status: "migrating" };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await client.migrateVM("vm-123", "node-2");

    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/live-migration`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ resource_id: "vm-123", target_node: "node-2" }),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it("should destroy a VM", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    const result = await client.destroyVM("vm-123");

    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/v1/resources/vm-123`,
      expect.objectContaining({
        method: "DELETE",
      }),
    );
    expect(result).toEqual({ success: true });
  });

  it("should handle API errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    } as Response);

    const result = await client.listVMs();

    expect(result).toHaveProperty("error");
    expect(result.error).toContain("BrainstormVM API 400");
    expect(result.error).toContain("Bad Request");
  });
});
