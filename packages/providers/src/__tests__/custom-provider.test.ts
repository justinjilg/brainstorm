import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCustomProviderKey,
  discoverOpenAICompatModels,
  inferModelLimits,
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

describe("inferModelLimits", () => {
  it("recognizes model families by id substring", () => {
    expect(inferModelLimits({ id: "h200/gpt-oss-120b" })).toEqual({
      limits: {
        contextWindow: 131072,
        maxOutputTokens: 32768,
        reasoning: true,
        toolCalling: true,
      },
      source: "heuristic",
    });
    expect(
      inferModelLimits({ id: "mac/qwen/qwen3-coder-next" }).limits
        .contextWindow,
    ).toBe(262144);
    expect(
      inferModelLimits({ id: "mac/text-embedding-qwen3-embedding-4b" }).limits
        .toolCalling,
    ).toBe(false);
  });

  it("prefers server-reported context length over the family heuristic", () => {
    const { limits, source } = inferModelLimits({
      id: "h200/gpt-oss-120b",
      max_model_len: 65536,
    });
    expect(source).toBe("server");
    expect(limits.contextWindow).toBe(65536);
    expect(limits.reasoning).toBe(true);
    // Output budget never exceeds the server-reported window.
    expect(limits.maxOutputTokens).toBeLessThanOrEqual(65536);
  });

  it("falls back to conservative defaults for unknown families", () => {
    const { limits, source } = inferModelLimits({ id: "mystery-model-7b" });
    expect(source).toBe("default");
    expect(limits).toEqual({
      contextWindow: 8192,
      maxOutputTokens: 4096,
      reasoning: false,
      toolCalling: true,
    });
  });

  it("does not overclaim windows for older generations of known families", () => {
    // gemma-2 and qwen1.5 have far smaller real windows than current
    // generations — they must fall to the conservative default, not 128k.
    for (const id of ["gemma-2-9b-it", "qwen1.5-7b-chat", "qwen-72b"]) {
      const { limits, source } = inferModelLimits({ id });
      expect(source, id).toBe("default");
      expect(limits.contextWindow, id).toBe(8192);
    }
    // Current generations still match.
    expect(inferModelLimits({ id: "gemma-4-31b" }).limits.contextWindow).toBe(
      131072,
    );
    expect(
      inferModelLimits({ id: "qwen2.5-coder-32b" }).limits.contextWindow,
    ).toBe(131072);
  });

  it("caps small checkpoints of current generations at 32k", () => {
    // qwen2.5-coder-0.5b / gemma-3-1b match current-generation families but
    // ship with far smaller windows than the full-size checkpoints.
    for (const id of ["qwen2.5-coder-0.5b", "gemma-3-1b-it"]) {
      const { limits } = inferModelLimits({ id });
      expect(limits.contextWindow, id).toBe(32768);
      expect(limits.maxOutputTokens, id).toBeLessThanOrEqual(32768);
    }
    // Size suffixes >= 7B keep the family window; A3B active-param suffixes
    // after the real size don't shadow it.
    expect(
      inferModelLimits({ id: "mac/qwen/qwen3.5-35b-a3b-8bit" }).limits
        .contextWindow,
    ).toBe(131072);
    expect(
      inferModelLimits({ id: "h200/Qwen/Qwen3-Next-80B-A3B-Instruct-FP8" })
        .limits.contextWindow,
    ).toBe(262144);
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

  it("excludes embedding-only models from the discovered registry", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "mac/text-embedding-qwen3-embedding-4b" },
          { id: "mac/qwen/qwen3-coder-next" },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await discoverOpenAICompatModels(
      "acme",
      "http://llm.acme.internal",
    );

    // The embedding model must not be routable as a chat model.
    expect(models.map((m) => m.name)).toEqual(["mac/qwen/qwen3-coder-next"]);
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
