/**
 * Ingest pipeline smoke tests — first tests for the ingest package.
 */

import { describe, it, expect } from "vitest";
import { detectLanguages } from "../languages.js";
import { detectFrameworks } from "../frameworks.js";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dirname, "../../../../..");

describe("Ingest Pipeline", () => {
  it("detects TypeScript as primary language", () => {
    const result = detectLanguages(PROJECT_ROOT);
    expect(result.primary).toBe("TypeScript");
    expect(result.languages.length).toBeGreaterThan(0);
  });

  it("returns a valid FrameworkDetection object", () => {
    const result = detectFrameworks(PROJECT_ROOT);
    expect(result).toBeDefined();
    expect(Array.isArray(result.frameworks)).toBe(true);
    expect(Array.isArray(result.buildTools)).toBe(true);
    expect(Array.isArray(result.packageManagers)).toBe(true);
  });

  it("language breakdown includes line counts and percentages", () => {
    const result = detectLanguages(PROJECT_ROOT);
    const ts = result.languages.find((l) => l.language === "TypeScript");
    expect(ts).toBeDefined();
    expect(ts!.lines).toBeGreaterThan(10000);
    expect(ts!.percentage).toBeGreaterThan(50);
  });
});
