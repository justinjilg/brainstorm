// Separate file (not in auto-verify.test.ts) because the other file mocks
// node:fs globally — the bug here was that detectBuildCommand tried to
// require("node:fs").readFileSync in an ESM module and threw "require is
// not defined", silently swallowed by a catch that left the package.json
// branch permanently dead. A real-fs test would have caught it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBuildCommand } from "../../builtin/auto-verify.js";

describe("detectBuildCommand (real fs)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "detect-build-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'npm run build' when package.json has a build script", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
    );
    expect(detectBuildCommand(dir)).toBe("npm run build");
  });

  it("returns null when package.json exists without a build script", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(detectBuildCommand(dir)).toBeNull();
  });

  it("returns null when package.json is invalid JSON", () => {
    writeFileSync(join(dir, "package.json"), "not valid json");
    expect(detectBuildCommand(dir)).toBeNull();
  });
});
