import { describe, it, expect, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CRITICAL: artifact-store captures ARTIFACTS_BASE at module import time
const TEST_HOME = mkdtempSync(join(tmpdir(), "brainstorm-artifact-validation-"));
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;

import { validateStepOutput } from "../engine.js";

// ── Artifact validation tests ───────────────────────────────────────

describe("validateStepOutput", () => {
  afterAll(() => {
    if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
    else delete process.env.HOME;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("accepts non-empty content", () => {
    const result = validateStepOutput(
      "step-1",
      "This is a valid output with content"
    );
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects empty string as invalid", () => {
    const result = validateStepOutput("step-empty", "");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/step-empty/i);
    expect(result.error).toMatch(/empty|whitespace/i);
  });

  it("rejects whitespace-only content as invalid", () => {
    const result = validateStepOutput("step-whitespace", "   \t\n  ");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/step-whitespace/i);
    expect(result.error).toMatch(/empty|whitespace/i);
  });

  it("rejects string of only spaces", () => {
    const result = validateStepOutput("step-spaces", "     ");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/step-spaces/i);
  });

  it("accepts content with just one non-whitespace character", () => {
    const result = validateStepOutput("step-minimal", "x");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("accepts content with leading/trailing whitespace but non-empty body", () => {
    const result = validateStepOutput(
      "step-trimmed",
      "  some content here  "
    );
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("provides clear error message naming the step and artifact", () => {
    const result = validateStepOutput("my-review-step", "");
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`Step "my-review-step"`);
    expect(result.error).toContain("artifact");
  });
});
