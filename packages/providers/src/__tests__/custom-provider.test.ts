import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCustomProviderKey,
  discoverOpenAICompatModels,
  inferModelLimits,
  createToolCallIdNormalizingFetch,
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

describe("createToolCallIdNormalizingFetch", () => {
  const sseResponse = (lines: string[]) =>
    new Response(lines.join("\n") + "\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  const readAll = async (res: Response) => {
    const text = await res.text();
    return text.split("\n").filter(Boolean);
  };

  it("synthesizes an id for the first chunk of an id-less tool call", async () => {
    const baseFetch = async () =>
      sseResponse([
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":null,"function":{"name":"file_read","arguments":"{\\"pa"}}]}}]}`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"x\\"}"}}]}}]}`,
        "data: [DONE]",
      ]);
    const fetch = createToolCallIdNormalizingFetch(baseFetch as any);
    const lines = await readAll(await fetch("http://x/v1/chat/completions"));

    const first = JSON.parse(lines[0].slice(5));
    expect(first.choices[0].delta.tool_calls[0].id).toBe("call_norm_0");
    // Continuation chunk (legal null/absent id) left untouched.
    const second = JSON.parse(lines[1].slice(5));
    expect("id" in second.choices[0].delta.tool_calls[0]).toBe(false);
    expect(lines[2]).toBe("data: [DONE]");
  });

  it("leaves server-provided ids and non-SSE responses untouched", async () => {
    const withId = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"grep"}}]}}]}`;
    const sse = createToolCallIdNormalizingFetch(
      (async () => sseResponse([withId, "data: [DONE]"])) as any,
    );
    const lines = await readAll(await sse("http://x"));
    expect(lines[0]).toBe(withId);

    const jsonBody = JSON.stringify({ ok: true });
    const plain = createToolCallIdNormalizingFetch(
      (async () =>
        new Response(jsonBody, {
          headers: { "content-type": "application/json" },
        })) as any,
    );
    expect(await (await plain("http://x")).text()).toBe(jsonBody);
  });

  it("assigns distinct ids per tool-call index and survives split chunks", async () => {
    const line1 = `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":null,"function":{"name":"a"}},{"index":1,"id":null,"function":{"name":"b"}}]}}]}`;
    // Deliver the SSE payload split mid-line across two body chunks.
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(line1.slice(0, 40)));
        controller.enqueue(encoder.encode(line1.slice(40) + "\ndata: [DONE]\n"));
        controller.close();
      },
    });
    const baseFetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const fetch = createToolCallIdNormalizingFetch(baseFetch as any);
    const lines = await readAll(await fetch("http://x"));
    const calls = JSON.parse(lines[0].slice(5)).choices[0].delta.tool_calls;
    expect(calls[0].id).toBe("call_norm_0");
    expect(calls[1].id).toBe("call_norm_1");
  });
});

describe("createToolCallIdNormalizingFetch — vLLM index-bump quirk", () => {
  it("re-points bumped-index argument fragments at the open call (captured gpt-oss shape)", async () => {
    // Verbatim shape captured live from vLLM/gpt-oss: one logical call whose
    // argument fragments arrive under a bumped index with no id/name.
    const lines = [
      `data: {"choices":[{"index":0,"delta":{"reasoning_content":" file_read.","tool_calls":[{"id":"chatcmpl-tool-b7c2","function":{"arguments":"","name":"file_read"},"type":"function","index":0},{"function":{"arguments":"{\\n "},"type":"function","index":0}]}}]}`,
      `data: {"choices":[{"stop_reason":200012,"index":0,"delta":{"tool_calls":[{"function":{"arguments":" \\"path\\": \\"/tmp/x.txt\\"\\n}"},"type":"function","index":1}]}}]}`,
      `data: {"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}]}`,
      "data: [DONE]",
    ];
    const baseFetch = async () =>
      new Response(lines.join("\n") + "\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const fetch = createToolCallIdNormalizingFetch(baseFetch as any);
    const out = (await (await fetch("http://x")).text())
      .split("\n")
      .filter(Boolean);

    const chunk1 = JSON.parse(out[0].slice(5));
    const [start, frag1] = chunk1.choices[0].delta.tool_calls;
    expect(start.index).toBe(0);
    expect(start.id).toBe("chatcmpl-tool-b7c2");
    expect(frag1.index).toBe(0);

    // The bumped index-1 fragment must be re-pointed at call 0.
    const chunk2 = JSON.parse(out[1].slice(5));
    expect(chunk2.choices[0].delta.tool_calls[0].index).toBe(0);
    expect("id" in chunk2.choices[0].delta.tool_calls[0]).toBe(false);

    // finish + DONE untouched.
    expect(out[2]).toBe(lines[2]);
    expect(out[3]).toBe("data: [DONE]");
  });

  it("keeps genuinely parallel calls distinct while collapsing their fragments", async () => {
    const lines = [
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"grep","arguments":""},"index":0}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"{}"},"index":1}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c2","function":{"name":"glob","arguments":""},"index":2}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"{}"},"index":3}]}}]}`,
    ];
    const baseFetch = async () =>
      new Response(lines.join("\n") + "\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const fetch = createToolCallIdNormalizingFetch(baseFetch as any);
    const out = (await (await fetch("http://x")).text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice(5)).choices[0].delta.tool_calls[0]);

    expect(out[0].index).toBe(0); // grep starts call 0
    expect(out[1].index).toBe(0); // its fragment follows it
    expect(out[2].index).toBe(1); // glob starts call 1 (server said 2)
    expect(out[3].index).toBe(1); // its fragment follows it
  });
});

describe("createToolCallIdNormalizingFetch — buffer cap", () => {
  it("fails open to pass-through when a single line exceeds the buffer cap", async () => {
    // >4MiB with no newline: normalization must stop buffering and pass raw
    // bytes through instead of exhausting memory.
    const huge = "data: " + "x".repeat(5 * 1024 * 1024);
    const tail = `\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":null,"function":{"name":"a","arguments":""}}]}}]}\n`;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(huge));
        controller.enqueue(encoder.encode(tail));
        controller.close();
      },
    });
    const baseFetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const fetch = createToolCallIdNormalizingFetch(baseFetch as any);
    const text = await (await fetch("http://x")).text();

    // All bytes preserved, and the post-overflow tool-call line is NOT
    // normalized (fail-open) — id stays null.
    expect(text).toContain("x".repeat(1024));
    expect(text).toContain('"id":null');
    expect(text).not.toContain("call_norm_");
  });
});

describe("createToolCallIdNormalizingFetch — interleaved parallel continuations", () => {
  it("routes fragments by seen server index, not just the most recent call", async () => {
    // Valid interleaved stream: both calls start, then their fragments
    // alternate using correct server indices. Fragments must follow their
    // own call — the recent-call fallback is only for unseen (quirk) indices.
    const lines = [
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"c1","function":{"name":"grep","arguments":""},"index":0},{"id":"c2","function":{"name":"glob","arguments":""},"index":1}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"{\\"a\\":1"},"index":0}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"{\\"b\\":2"},"index":1}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"}"},"index":0}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"}"},"index":1}]}}]}`,
    ];
    const baseFetch = async () =>
      new Response(lines.join("\n") + "\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const fetch = createToolCallIdNormalizingFetch(baseFetch as any);
    const out = (await (await fetch("http://x")).text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice(5)).choices[0].delta.tool_calls);

    expect(out[0].map((c: any) => c.index)).toEqual([0, 1]);
    expect(out[1][0].index).toBe(0); // c1 fragment stays on call 0
    expect(out[2][0].index).toBe(1); // c2 fragment stays on call 1
    expect(out[3][0].index).toBe(0);
    expect(out[4][0].index).toBe(1);
  });
});
