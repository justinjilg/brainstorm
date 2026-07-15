import { describe, expect, it } from "vitest";
import {
  segmentsToSystemArray,
  type SystemPromptSegment,
} from "../agent/context.js";

describe("segmentsToSystemArray", () => {
  it("marks the cacheable segment with both the anthropic and openai-compatible cache hints", () => {
    const segments: SystemPromptSegment[] = [
      { text: "stable prefix", cacheable: true },
      { text: "dynamic tail", cacheable: false },
    ];

    const result = segmentsToSystemArray(segments);

    expect(result).toEqual([
      {
        role: "system",
        content: "stable prefix",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
          openaiCompatible: { cache_control: { type: "ephemeral" } },
        },
      },
      { role: "system", content: "dynamic tail" },
    ]);
  });

  it("never sets a cache hint on a non-cacheable segment", () => {
    const segments: SystemPromptSegment[] = [
      { text: "dynamic only", cacheable: false },
    ];

    const result = segmentsToSystemArray(segments);

    expect(result).toEqual([{ role: "system", content: "dynamic only" }]);
  });

  it("caps at exactly ONE cache breakpoint even if multiple segments are cacheable", () => {
    // Anthropic allows up to 4 breakpoints, but we deliberately stay at 1.
    // Only the LAST cacheable segment should get the hint.
    const segments: SystemPromptSegment[] = [
      { text: "cacheable one", cacheable: true },
      { text: "cacheable two", cacheable: true },
      { text: "dynamic", cacheable: false },
      { text: "cacheable three (last cacheable)", cacheable: true },
    ];

    const result = segmentsToSystemArray(segments);

    const withCacheHints = result.filter((seg) => seg.providerOptions);
    expect(withCacheHints).toHaveLength(1);
    expect(withCacheHints[0].content).toBe("cacheable three (last cacheable)");
    expect(withCacheHints[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
      openaiCompatible: { cache_control: { type: "ephemeral" } },
    });
  });
});
