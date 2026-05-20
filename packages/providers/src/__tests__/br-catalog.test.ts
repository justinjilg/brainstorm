import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  brEntryToModel,
  mergeBrCatalog,
  fetchBrCatalog,
  type BrCatalogEntry,
} from "../cloud/br-catalog.js";
import { CLOUD_MODELS } from "../cloud/models.js";
import type { ModelEntry } from "@brainst0rm/shared";

describe("brEntryToModel", () => {
  it("uses BR pricing and capability flags when present", () => {
    const br: BrCatalogEntry = {
      id: "openai/gpt-5.5",
      owned_by: "openai",
      x_model_router: {
        pricing: { input: 5, output: 15 },
        capabilities: ["streaming", "vision", "tools"],
      },
    };
    const model = brEntryToModel(br, new Map());
    expect(model.id).toBe("openai/gpt-5.5");
    expect(model.provider).toBe("openai");
    expect(model.pricing.inputPer1MTokens).toBe(5);
    expect(model.pricing.outputPer1MTokens).toBe(15);
    expect(model.capabilities.toolCalling).toBe(true);
    expect(model.capabilities.vision).toBe(true);
    expect(model.capabilities.streaming).toBe(true);
  });

  it("overlays local qualityTier/speedTier/bestFor/scores when id matches", () => {
    const local: ModelEntry = {
      id: "anthropic/claude-opus-4-6",
      provider: "anthropic",
      name: "Claude Opus 4.6",
      capabilities: {
        toolCalling: true,
        streaming: true,
        vision: true,
        reasoning: true,
        contextWindow: 1_000_000,
        qualityTier: 1,
        speedTier: 3,
        bestFor: ["analysis"],
        capabilityScores: {
          toolSelection: 0.96,
          toolSequencing: 0.94,
          codeGeneration: 0.95,
          multiStepReasoning: 0.97,
          instructionFollowing: 0.95,
          contextUtilization: 0.96,
          selfCorrection: 0.93,
        },
      },
      pricing: { inputPer1MTokens: 15, outputPer1MTokens: 75 },
      limits: { contextWindow: 1_000_000, maxOutputTokens: 32_768 },
      status: "available",
      isLocal: false,
      lastHealthCheck: 0,
    };
    const br: BrCatalogEntry = {
      id: "anthropic/claude-opus-4-6",
      owned_by: "anthropic",
      x_model_router: { pricing: { input: 15, output: 75 } },
    };
    const model = brEntryToModel(br, new Map([[local.id, local]]));
    expect(model.capabilities.qualityTier).toBe(1);
    expect(model.capabilities.speedTier).toBe(3);
    expect(model.capabilities.bestFor).toEqual(["analysis"]);
    expect(model.capabilities.capabilityScores?.toolSelection).toBe(0.96);
    expect(model.name).toBe("Claude Opus 4.6");
  });

  it("applies safe defaults for an unknown id with no local overlay", () => {
    const br: BrCatalogEntry = {
      id: "x-ai/grok-3",
      owned_by: "x-ai",
    };
    const model = brEntryToModel(br, new Map());
    expect(model.capabilities.qualityTier).toBe(2);
    expect(model.capabilities.speedTier).toBe(2);
    expect(model.capabilities.contextWindow).toBe(128_000);
    expect(model.capabilities.toolCalling).toBe(false);
    expect(model.pricing.inputPer1MTokens).toBe(0);
    expect(model.name).toBe("grok-3");
    expect(model.status).toBe("available");
    expect(model.isLocal).toBe(false);
  });

  it("infers provider from id when owned_by is missing", () => {
    const br: BrCatalogEntry = { id: "moonshot/kimi-k2.6" };
    expect(brEntryToModel(br, new Map()).provider).toBe("moonshot");
  });
});

describe("mergeBrCatalog", () => {
  it("returns one entry per BR id (BR is source of truth for catalog membership)", () => {
    const brEntries: BrCatalogEntry[] = [
      { id: "openai/gpt-5.5", owned_by: "openai" },
      { id: "x-ai/grok-3", owned_by: "x-ai" },
    ];
    const result = mergeBrCatalog(brEntries, CLOUD_MODELS);
    expect(result.map((m) => m.id)).toEqual(["openai/gpt-5.5", "x-ai/grok-3"]);
  });

  it("does NOT include local-only models that BR doesn't serve", () => {
    // A model present in CLOUD_MODELS but not in BR's catalog should not appear.
    const localOnly = CLOUD_MODELS[0]!;
    const brEntries: BrCatalogEntry[] = [{ id: "openai/gpt-5.5" }];
    const result = mergeBrCatalog(brEntries, [localOnly]);
    expect(result.find((m) => m.id === localOnly.id)).toBeUndefined();
    expect(result).toHaveLength(1);
  });

  it("preserves local capability metadata for matched ids", () => {
    const opus = CLOUD_MODELS.find((m) => m.id === "anthropic/claude-opus-4-6");
    expect(opus).toBeDefined();
    const brEntries: BrCatalogEntry[] = [
      { id: "anthropic/claude-opus-4-6", owned_by: "anthropic" },
    ];
    const [merged] = mergeBrCatalog(brEntries, CLOUD_MODELS);
    expect(merged!.capabilities.qualityTier).toBe(
      opus!.capabilities.qualityTier,
    );
    expect(merged!.capabilities.capabilityScores).toEqual(
      opus!.capabilities.capabilityScores,
    );
  });
});

describe("fetchBrCatalog", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("returns parsed data[] on 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        object: "list",
        data: [{ id: "openai/gpt-5.5", owned_by: "openai" }],
      }),
    }) as unknown as typeof fetch;
    const result = await fetchBrCatalog("br_live_test");
    expect(result).toEqual([{ id: "openai/gpt-5.5", owned_by: "openai" }]);
  });

  it("returns null on non-2xx (no throw)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "auth" }),
    }) as unknown as typeof fetch;
    const result = await fetchBrCatalog("bad_key");
    expect(result).toBeNull();
  });

  it("returns null on network error (no throw)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("network unreachable"),
      ) as unknown as typeof fetch;
    const result = await fetchBrCatalog("br_live_test");
    expect(result).toBeNull();
  });

  it("returns null when response has no data[] array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ object: "list" }), // missing data
    }) as unknown as typeof fetch;
    const result = await fetchBrCatalog("br_live_test");
    expect(result).toBeNull();
  });

  it("sends Bearer Authorization header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await fetchBrCatalog("br_live_xyz");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/v1/models"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer br_live_xyz",
        }),
      }),
    );
  });
});
