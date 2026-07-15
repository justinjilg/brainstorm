/**
 * Tests for describeFinishReason — the helper that turns a non-`stop` provider
 * finishReason into a human diagnostic so callers (e.g. the SWE-bench eval) can
 * surface WHY a run produced no output instead of a silent "no changes".
 */

import { describe, it, expect } from "vitest";
import { describeFinishReason } from "../agent/subagent.js";

describe("describeFinishReason", () => {
  it("returns null for normal completions (no callout needed)", () => {
    expect(describeFinishReason("stop")).toBeNull();
    expect(describeFinishReason("tool-calls")).toBeNull();
    expect(describeFinishReason(undefined)).toBeNull();
  });

  it("explains a provider content-filter block", () => {
    const msg = describeFinishReason("content-filter");
    expect(msg).toBeTruthy();
    expect(msg!.toLowerCase()).toContain("content filter");
  });

  it("explains length and error terminations", () => {
    expect(describeFinishReason("length")).toMatch(/token limit/i);
    expect(describeFinishReason("error")).toMatch(/error/i);
    expect(describeFinishReason("other")).toBeTruthy();
  });

  it("does not call out unknown reasons (fails safe to null)", () => {
    expect(describeFinishReason("some-future-reason")).toBeNull();
  });
});
