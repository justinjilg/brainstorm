import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveRepoRoot } from "../runner.js";

describe("resolveRepoRoot", () => {
  let tempRoot: string;

  beforeEach(() => {
    const { tmpdir } = require("node:os") as typeof import("node:os");
    tempRoot = join(tmpdir(), `brainstorm-test-repo-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempRoot, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true });
    }
  });

  it("resolves repo root from nested subdirectory when pnpm-workspace.yaml exists at top", () => {
    // Create a temp directory structure like:
    // tempRoot/
    //   pnpm-workspace.yaml
    //   nested/
    //     deeper/

    const workspaceFile = join(tempRoot, "pnpm-workspace.yaml");
    writeFileSync(workspaceFile, "packages:\n  - \"*\"\n", "utf-8");

    const nestedDir = join(tempRoot, "nested");
    mkdirSync(nestedDir, { recursive: true });

    const deeperDir = join(nestedDir, "deeper");
    mkdirSync(deeperDir, { recursive: true });

    // Resolve from the deepest nested directory
    const root = resolveRepoRoot(deeperDir);
    expect(root).toBe(resolve(tempRoot));
  });

  it("throws error when pnpm-workspace.yaml not found within search depth", () => {
    // Create a nested directory WITHOUT pnpm-workspace.yaml
    const deepDir = join(tempRoot, "a", "b", "c", "d", "e");
    mkdirSync(deepDir, { recursive: true });

    expect(() => resolveRepoRoot(deepDir)).toThrow(/Could not find pnpm-workspace.yaml/);
    // The message must not advertise CLI flags that don't exist — it points
    // at RunnerOptions.projectDir instead.
    expect(() => resolveRepoRoot(deepDir)).toThrow(/RunnerOptions\.projectDir/);
  });

  it("returns start directory when pnpm-workspace.yaml is at start", () => {
    const workspaceFile = join(tempRoot, "pnpm-workspace.yaml");
    writeFileSync(workspaceFile, "packages:\n  - \"*\"\n", "utf-8");

    const root = resolveRepoRoot(tempRoot);
    expect(root).toBe(resolve(tempRoot));
  });
});
