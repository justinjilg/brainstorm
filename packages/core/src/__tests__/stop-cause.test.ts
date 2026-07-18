import { describe, it, expect } from "vitest";
import { classifyStopCause } from "../agent/loop.js";

const base = {
  isEmpty: false,
  toolCallTruncated: false,
  stepsCompleted: 1,
  maxSteps: 10,
  lastStepFinishReason: "stop" as string | undefined,
  providerFinishReason: undefined as string | undefined,
};

describe("classifyStopCause", () => {
  it("returns natural_stop for a clean completed turn", () => {
    expect(classifyStopCause(base)).toBe("natural_stop");
  });

  it("prioritizes truncation over everything else", () => {
    expect(
      classifyStopCause({
        ...base,
        toolCallTruncated: true,
        isEmpty: true,
        stepsCompleted: 10,
        lastStepFinishReason: "tool-calls",
      }),
    ).toBe("truncated_tool_call");
  });

  it("asserts step_cap_reached only when the budget is spent AND the last step wanted to continue", () => {
    // Cap reached, last step still wants tools → capped.
    expect(
      classifyStopCause({
        ...base,
        stepsCompleted: 10,
        maxSteps: 10,
        lastStepFinishReason: "tool-calls",
      }),
    ).toBe("step_cap_reached");
    // A bare terminal "tool-calls" WITHOUT reaching the cap is NOT a cap.
    expect(
      classifyStopCause({
        ...base,
        stepsCompleted: 3,
        maxSteps: 10,
        lastStepFinishReason: "tool-calls",
      }),
    ).not.toBe("step_cap_reached");
  });

  it("maps provider length and content-filter finish reasons", () => {
    expect(
      classifyStopCause({ ...base, providerFinishReason: "length" }),
    ).toBe("output_limit");
    expect(
      classifyStopCause({ ...base, providerFinishReason: "content-filter" }),
    ).toBe("content_filtered");
  });

  it("returns empty_output for a no-text non-truncated turn", () => {
    expect(classifyStopCause({ ...base, isEmpty: true })).toBe("empty_output");
  });

  it("length at the step cap classifies as a cap, not output_limit", () => {
    // A capped run whose final step hit length is still fundamentally a cap.
    expect(
      classifyStopCause({
        ...base,
        stepsCompleted: 6,
        maxSteps: 6,
        lastStepFinishReason: "length",
      }),
    ).toBe("step_cap_reached");
  });
});
