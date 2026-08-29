/**
 * Ingest pipeline smoke tests — first tests for the ingest package.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectLanguages } from "../languages.js";
import { detectFrameworks } from "../frameworks.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "brainstorm-ingest-test-"));
  mkdirSync(join(fixtureRoot, "src"));
  writeFileSync(
    join(fixtureRoot, "src", "index.ts"),
    [
      "export function greet(name: string): string {",
      "  return `Hello, ${name}`;",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(fixtureRoot, "src", "math.ts"),
    "export const add = (left: number, right: number): number => left + right;\n",
  );
  writeFileSync(join(fixtureRoot, "script.py"), "print('fixture')\n");
  writeFileSync(
    join(fixtureRoot, "package.json"),
    JSON.stringify({ dependencies: { react: "19.0.0", vite: "7.0.0" } }),
  );
  writeFileSync(
    join(fixtureRoot, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
  );
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("Ingest Pipeline", () => {
  it("detects TypeScript as primary language", () => {
    const result = detectLanguages(fixtureRoot);
    expect(result.primary).toBe("TypeScript");
    expect(result.languages.length).toBeGreaterThan(0);
  });

  it("returns a valid FrameworkDetection object", () => {
    const result = detectFrameworks(fixtureRoot);
    expect(result.frameworks).toContain("React");
    expect(result.buildTools).toContain("Vite");
    expect(result.packageManagers).toContain("pnpm");
  });

  it("language breakdown includes line counts and percentages", () => {
    const result = detectLanguages(fixtureRoot);
    const ts = result.languages.find((l) => l.language === "TypeScript");
    expect(ts).toBeDefined();
    expect(ts?.files).toBe(2);
    expect(ts?.lines).toBe(4);
    expect(ts?.percentage).toBe(80);
    expect(result.totalLines).toBe(5);
    expect(result.totalFiles).toBe(3);
  });
});
