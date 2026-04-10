import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MSPClient } from "./client";
import type { ConnectorConfig } from "../../types";

const config: ConnectorConfig = {
  enabled: true,
  baseUrl: "https://msp.example.com",
  apiKeyName: "TEST_MSP_API_KEY",
};

describe("MSPClient", () => {
  const originalEnv = process.env.TEST_MSP_API_KEY;

  beforeEach(() => {
    process.env.TEST_MSP_API_KEY = "secret-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    if (originalEnv === undefined) {
      delete process.env.TEST_MSP_API_KEY;
      return;
    }

    process.env.TEST_MSP_API_KEY = originalEnv;
  });

  it("returns parsed JSON for 200 responses and sends auth headers", async () => {
    const json = vi.fn().mockResolvedValue({ ok: true, devices: [] });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json,
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new MSPClient(config);
    const result = await client.apiFetch("/api/v1/discovery/stats", {
      method: "GET",
      headers: {
        "X-Trace-Id": "trace-123",
      },
    });

    expect(result).toEqual({ ok: true, devices: [] });
    expect(json).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://msp.example.com/api/v1/discovery/stats",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-key",
          "Content-Type": "application/json",
          "X-Trace-Id": "trace-123",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns a descriptive error for 4xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue("missing device"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new MSPClient(config);
    const result = await client.getDevice("device-404");

    expect(result).toEqual({
      error: "BrainstormMSP API 404: missing device",
    });
  });

  it("returns a descriptive error for 5xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue("service unavailable"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new MSPClient(config);
    const result = await client.retryBackup("job-503");

    expect(result).toEqual({
      error: "BrainstormMSP API 503: service unavailable",
    });
  });

  it("returns a missing credential error without calling fetch", async () => {
    delete process.env.TEST_MSP_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new MSPClient(config);
    const result = await client.apiFetch("/health");

    expect(result).toEqual({
      error: "No API key for BrainstormMSP (TEST_MSP_API_KEY)",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports transport errors as failed health checks", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new MSPClient(config);
    const result = await client.healthCheck();

    expect(result.ok).toBe(false);
    expect(result.message).toBe("BrainstormMSP API error: socket hang up");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
