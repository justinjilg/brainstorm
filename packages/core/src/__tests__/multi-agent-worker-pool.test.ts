import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  listFilesTouched,
  wrapTaskWithSafetyPreamble,
  detectUnauthorizedDepChanges,
} from "../plan/multi-agent-worker-pool.js";

const tempDirs: string[] = [];

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wpool-test-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  // Need an initial commit so git status output is meaningful.
  writeFileSync(join(dir, "README.md"), "initial\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("listFilesTouched (worker pool helper)", () => {
  it("returns empty array for a clean worktree", () => {
    const dir = makeGitRepo();
    expect(listFilesTouched(dir)).toEqual([]);
  });

  it("detects untracked files", () => {
    const dir = makeGitRepo();
    writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");
    const files = listFilesTouched(dir);
    expect(files).toContain("new.ts");
  });

  it("detects unstaged modifications", () => {
    const dir = makeGitRepo();
    writeFileSync(join(dir, "README.md"), "modified\n");
    const files = listFilesTouched(dir);
    expect(files).toContain("README.md");
  });

  it("detects staged additions", () => {
    const dir = makeGitRepo();
    writeFileSync(join(dir, "feature.ts"), "export const f = 2;\n");
    execFileSync("git", ["add", "feature.ts"], { cwd: dir });
    const files = listFilesTouched(dir);
    expect(files).toContain("feature.ts");
  });

  it("detects mixed staged + unstaged + untracked", () => {
    const dir = makeGitRepo();
    // Untracked
    writeFileSync(join(dir, "untracked.ts"), "x\n");
    // Staged add
    writeFileSync(join(dir, "staged.ts"), "y\n");
    execFileSync("git", ["add", "staged.ts"], { cwd: dir });
    // Unstaged modification
    writeFileSync(join(dir, "README.md"), "changed\n");

    const files = listFilesTouched(dir);
    expect(files.sort()).toEqual(
      ["README.md", "staged.ts", "untracked.ts"].sort(),
    );
  });

  it("handles nested directory paths", () => {
    const dir = makeGitRepo();
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    writeFileSync(join(dir, "src", "deep", "file.ts"), "x\n");
    const files = listFilesTouched(dir);
    expect(files).toContain("src/deep/file.ts");
  });

  it("returns empty array when given a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "wpool-non-git-"));
    tempDirs.push(dir);
    expect(listFilesTouched(dir)).toEqual([]);
  });
});

describe("wrapTaskWithSafetyPreamble", () => {
  it("prepends the safety preamble to the task prompt", () => {
    const task = "add a unit test to packages/db";
    const wrapped = wrapTaskWithSafetyPreamble(task);
    // Preamble comes first
    expect(wrapped.indexOf("Safety rules")).toBeLessThan(wrapped.indexOf(task));
    // Task still present
    expect(wrapped).toContain(task);
  });

  it("mentions additive-by-default rule", () => {
    const wrapped = wrapTaskWithSafetyPreamble("add a test");
    expect(wrapped).toContain("Additive by default");
    expect(wrapped).toContain("without modifying or");
    expect(wrapped).toMatch(/existing/i);
  });

  it("forbids dep changes in the preamble", () => {
    const wrapped = wrapTaskWithSafetyPreamble("add a test");
    expect(wrapped).toContain("npm install");
    expect(wrapped).toContain("package.json");
    expect(wrapped).toContain("package-lock.json");
  });
});

describe("detectUnauthorizedDepChanges", () => {
  it("returns empty when no dep files were touched", () => {
    const files = ["src/foo.ts", "src/bar.ts"];
    expect(detectUnauthorizedDepChanges(files, "add a test")).toEqual([]);
  });

  it("flags package.json when task did not ask for deps", () => {
    const files = ["src/foo.ts", "packages/gateway/package.json"];
    const unauth = detectUnauthorizedDepChanges(files, "add a test");
    expect(unauth).toEqual(["packages/gateway/package.json"]);
  });

  it("flags package-lock.json", () => {
    const files = ["package-lock.json"];
    const unauth = detectUnauthorizedDepChanges(files, "add a test");
    expect(unauth).toEqual(["package-lock.json"]);
  });

  it("allows dep changes when task mentions install", () => {
    const files = ["packages/gateway/package.json", "package-lock.json"];
    const unauth = detectUnauthorizedDepChanges(
      files,
      "install the express package and add a route",
    );
    expect(unauth).toEqual([]);
  });

  it("allows dep changes when task mentions upgrade", () => {
    const files = ["package.json", "package-lock.json"];
    const unauth = detectUnauthorizedDepChanges(
      files,
      "upgrade typescript to 5.7",
    );
    expect(unauth).toEqual([]);
  });

  it("flags multiple dep files at once", () => {
    const files = [
      "src/foo.ts",
      "package.json",
      "package-lock.json",
      "yarn.lock",
    ];
    const unauth = detectUnauthorizedDepChanges(files, "refactor foo");
    expect(unauth.sort()).toEqual(
      ["package-lock.json", "package.json", "yarn.lock"].sort(),
    );
  });

  it("flags python requirements.txt and poetry.lock", () => {
    const files = ["requirements.txt", "poetry.lock", "app.py"];
    const unauth = detectUnauthorizedDepChanges(files, "fix the bug in app.py");
    expect(unauth.sort()).toEqual(["poetry.lock", "requirements.txt"]);
  });

  it("flags Cargo.toml and Cargo.lock", () => {
    const files = ["Cargo.toml", "Cargo.lock", "src/main.rs"];
    const unauth = detectUnauthorizedDepChanges(files, "fix the parser bug");
    expect(unauth.sort()).toEqual(["Cargo.lock", "Cargo.toml"]);
  });
});
