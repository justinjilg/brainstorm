import { describe, it, expect, vi } from "vitest";
import { fetchBrModelCatalog } from "../cloud/brainstorm-saas.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("fetchBrModelCatalog", () => {
  it("synthesizes a ModelEntry per model and derives provider from the id prefix", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        object: "list",
        data: [
          { id: "openai/gpt-x", capabilities: { tool_calling: true } },
          { id: "anthropic/claude-y" },
        ],
      }),
    ) as unknown as typeof fetch;

    const models = await fetchBrModelCatalog("br-key", { fetchImpl });

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "openai/gpt-x",
      provider: "openai",
      isLocal: false,
      status: "available",
      pricing: { inputPer1MTokens: 0, outputPer1MTokens: 0 },
    });
    expect(models[0].capabilities.toolCalling).toBe(true);
    expect(models[1].provider).toBe("anthropic");
    // Conservative default when the catalog is silent about tools.
    expect(models[1].capabilities.toolCalling).toBe(false);
  });

  it("recognizes tool-calling across flat flags and feature arrays", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "a/flat", supports_tools: true },
          { id: "a/func", function_calling: true },
          { id: "a/features", features: ["vision", "tool_calling"] },
          { id: "a/nested", capabilities: { function_calling: true } },
          { id: "a/none", capabilities: { streaming: true } },
        ],
      }),
    ) as unknown as typeof fetch;

    const models = await fetchBrModelCatalog("br-key", { fetchImpl });
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["a/flat"].capabilities.toolCalling).toBe(true);
    expect(byId["a/func"].capabilities.toolCalling).toBe(true);
    expect(byId["a/features"].capabilities.toolCalling).toBe(true);
    expect(byId["a/nested"].capabilities.toolCalling).toBe(true);
    expect(byId["a/none"].capabilities.toolCalling).toBe(false);
  });

  it("returns an empty array (never throws) on network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(fetchBrModelCatalog("br-key", { fetchImpl })).resolves.toEqual(
      [],
    );
  });

  it("returns an empty array on non-2xx responses", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "unauthorized" }, 401),
    ) as unknown as typeof fetch;

    await expect(fetchBrModelCatalog("br-key", { fetchImpl })).resolves.toEqual(
      [],
    );
  });

  it("returns an empty array on malformed JSON body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(fetchBrModelCatalog("br-key", { fetchImpl })).resolves.toEqual(
      [],
    );
  });

  it("skips silently when no key is configured", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(fetchBrModelCatalog("", { fetchImpl })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("de-dupes and skips entries without a usable id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: "dup" },
          { id: "dup" },
          { id: "" },
          { notAnId: true },
          null,
        ],
      }),
    ) as unknown as typeof fetch;

    const models = await fetchBrModelCatalog("br-key", { fetchImpl });
    expect(models.map((m) => m.id)).toEqual(["dup"]);
  });
});
