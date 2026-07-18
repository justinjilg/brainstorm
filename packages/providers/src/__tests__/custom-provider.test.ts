import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCustomProviderKey,
  discoverOpenAICompatModels,
} from "../local/openai-compat.js";

describe("resolveCustomProviderKey", () => {
  it("returns null when neither apiKeyEnv nor apiKeyFile is set", () => {
    expect(resolveCustomProviderKey({})).toBeNull();
  });

  it("prefers apiKeyEnv over apiKeyFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-key-"));
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "file-token\n");
    try {
      const key = resolveCustomProviderKey(
        { apiKeyEnv: "SOME_KEY", apiKeyFile: keyFile },
        (name) => (name === "SOME_KEY" ? "env-token" : null),
      );
      expect(key).toBe("env-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a trimmed apiKeyFile when the env var is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-key-"));
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "  file-token\n");
    try {
      const key = resolveCustomProviderKey(
        { apiKeyEnv: "UNSET_KEY", apiKeyFile: keyFile },
        () => null,
      );
      expect(key).toBe("file-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an unreadable key file instead of throwing", () => {
    const key = resolveCustomProviderKey(
      { apiKeyFile: "/nonexistent/path/key" },
      () => null,
    );
    expect(key).toBeNull();
  });
});

describe("discoverOpenAICompatModels with custom providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes auth headers and prefixes model ids with the provider name", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "h200/gpt-oss-120b" }, { id: "mac/qwen3.6-27b" }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await discoverOpenAICompatModels(
      "acme",
      "http://llm.acme.internal",
      { Authorization: "Bearer acme-token" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://llm.acme.internal/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer acme-token" },
      }),
    );
    expect(models.map((m) => m.id)).toEqual([
      "acme:h200/gpt-oss-120b",
      "acme:mac/qwen3.6-27b",
    ]);
    expect(models.every((m) => m.provider === "acme" && m.isLocal)).toBe(true);
  });

  it("omits the headers key entirely when no auth is configured", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ data: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await discoverOpenAICompatModels("acme", "http://llm.acme.internal");

    const init = fetchMock.mock.calls[0][1] ?? {};
    expect("headers" in init).toBe(false);
  });
});
