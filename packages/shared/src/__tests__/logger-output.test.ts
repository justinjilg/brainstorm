import { describe, expect, it } from "vitest";
import { isStructuredOutputArgs } from "../logger.js";

describe("structured-output logger isolation", () => {
  it.each(["ipc", "--json", "--events"])(
    "reserves stdout when argv contains %s",
    (flag) => {
      expect(isStructuredOutputArgs(["node", "brainstorm", "run", flag])).toBe(
        true,
      );
    },
  );

  it("keeps ordinary human commands on the default log destination", () => {
    expect(
      isStructuredOutputArgs(["node", "brainstorm", "run", "say hello"]),
    ).toBe(false);
  });
});
