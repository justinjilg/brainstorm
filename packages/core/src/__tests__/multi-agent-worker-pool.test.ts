import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { listFilesTouched } from "../plan/multi-agent-worker-pool.js";

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
