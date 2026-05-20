import { resolve4, resolve6 } from "node:dns/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertPublicFetchUrl, webFetchTool } from "../builtin/web-fetch";

vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

const mockResolve4 = vi.mocked(resolve4);
const mockResolve6 = vi.mocked(resolve6);

describe("web_fetch SSRF controls", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
    globalThis.fetch = originalFetch;
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    mockResolve6.mockResolvedValue([]);
  });

  it("blocks non-http protocols before network I/O", async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const result = await webFetchTool.execute({ url: "file:///etc/passwd" });

    expect(result).toMatchObject({
      error: "Blocked URL: only http and https URLs are allowed",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks loopback and metadata hostnames", async () => {
    await expect(
      assertPublicFetchUrl("http://localhost:8080"),
    ).resolves.toEqual({
      ok: false,
      reason: "loopback or metadata hostname is not allowed",
    });

    await expect(
      assertPublicFetchUrl("http://metadata.google.internal/"),
    ).resolves.toEqual({
      ok: false,
      reason: "loopback or metadata hostname is not allowed",
    });
  });

  it("blocks raw private and link-local IP addresses", async () => {
    await expect(
      assertPublicFetchUrl("http://10.0.0.10/admin"),
    ).resolves.toEqual({
      ok: false,
      reason: "private, loopback, or reserved IP address is not allowed",
    });

    await expect(
      assertPublicFetchUrl("http://169.254.169.254/latest/meta-data"),
    ).resolves.toEqual({
      ok: false,
      reason: "private, loopback, or reserved IP address is not allowed",
    });
  });

  it("blocks hostnames that resolve to private addresses", async () => {
    mockResolve4.mockResolvedValue(["192.168.1.25"]);
    const fetch = vi.fn();
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const result = await webFetchTool.execute({
      url: "https://internal.example.test",
    });

    expect(result).toMatchObject({
      error: "Blocked URL: hostname resolves to blocked address 192.168.1.25",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-checks redirect targets before following them", async () => {
    const fetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const result = await webFetchTool.execute({
      url: "https://example.com/start",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      error:
        "Blocked URL: private, loopback, or reserved IP address is not allowed",
    });
  });

  it("fetches public http and https URLs", async () => {
    const fetch = vi.fn(async () => {
      return new Response("public content", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;

    const result = await webFetchTool.execute({
      url: "https://example.com/docs",
      maxLength: 6,
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://example.com/docs"),
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(result).toMatchObject({
      content: "public",
      truncated: true,
      contentType: "text/plain",
      url: "https://example.com/docs",
    });
  });
});
