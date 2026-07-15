import { describe, expect, test } from "vitest";
import { OUTPUT_SCHEMAS, getOutputSchema, verdict } from "../schemas.js";

describe("OUTPUT_SCHEMAS verdict registration", () => {
  test("verdict is registered under key 'verdict'", () => {
    expect(OUTPUT_SCHEMAS["verdict"]).toBeDefined();
    expect(getOutputSchema("verdict")).toBe(verdict);
  });

  test("verdict accepts a well-formed judge verdict", () => {
    const res = verdict.safeParse({
      pass: true,
      score: 0.9,
      confidence: 0.8,
      rationale: "Correct and idiomatic.",
      findings: [
        { severity: "low", description: "minor style nit", file: "src/a.ts" },
      ],
      criteriaResults: [{ criterion: "builds", pass: true }],
    });
    expect(res.success).toBe(true);
  });

  test("verdict rejects a missing required field", () => {
    const res = verdict.safeParse({ pass: true, findings: [] });
    expect(res.success).toBe(false);
  });
});
