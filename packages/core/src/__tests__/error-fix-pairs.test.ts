import { describe, it, expect } from "vitest";
import { normalizeErrorSignature } from "../learning/error-fix-pairs.js";

describe("normalizeErrorSignature", () => {
  it("strips absolute and relative file paths from error messages", () => {
    const error1 =
      "Error in /Users/justin/Projects/brainstorm/packages/core/src/index.ts: Module not found";
    const error2 = "Failed at ./src/components/Button.tsx";

    expect(normalizeErrorSignature(error1)).toBe(
      "Error in <path>: Module not found",
    );
    expect(normalizeErrorSignature(error2)).toBe("Failed at <path>");
  });

  it("strips line and column numbers formatted as :line:column", () => {
    const error =
      "SyntaxError: Unexpected token at Object.<anonymous> (/app/index.js:15:30)";
    expect(normalizeErrorSignature(error)).toBe(
      "SyntaxError: Unexpected token at Object.<anonymous> (<path>:<line>)",
    );
  });

  it("strips 'line N' formatting ignoring case", () => {
    const error1 = "Parse error on line 42: unexpected EOF";
    const error2 = "Error at LINE 100: missing semicolon";

    expect(normalizeErrorSignature(error1)).toBe(
      "Parse error on line <N>: unexpected EOF",
    );
    expect(normalizeErrorSignature(error2)).toBe(
      "Error at line <N>: missing semicolon",
    );
  });

  it("strips timestamps in common formats", () => {
    const error1 = "[2026-04-10 12:25:00] FATAL ERROR: Process out of memory";
    const error2 = "2026-04-10T12:25:00 Error: connection reset";

    expect(normalizeErrorSignature(error1)).toBe(
      "[<timestamp>] FATAL ERROR: Process out of memory",
    );
    expect(normalizeErrorSignature(error2)).toBe(
      "<timestamp> Error: connection reset",
    );
  });

  it("normalizes whitespace and truncates long signatures to 200 characters", () => {
    const error =
      "Error:   \n   \t  Failed to compile.\n\n\n" + "A".repeat(300);
    const normalized = normalizeErrorSignature(error);

    expect(normalized.startsWith("Error: Failed to compile. AAAAA")).toBe(true);
    expect(normalized.length).toBe(200);
  });
});
