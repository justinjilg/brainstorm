/**
 * Git-backed memory versioning.
 *
 * Every memory save/delete creates a git commit in the memory directory.
 * Provides diffing, history, and branch support for memory state.
 *
 * Uses execFileSync (no shell injection risk) for all git operations.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("memory-git");

// 10s timeout prevents indefinite hangs on git lock files or slow NFS
const GIT_TIMEOUT_MS = 10_000;

function git(
  memoryDir: string,
  args: string[],
  opts?: { encoding?: BufferEncoding },
): string {
  return execFileSync("git", args, {
    cwd: memoryDir,
    encoding: opts?.encoding ?? "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
  }) as string;
}

function gitSilent(memoryDir: string, args: string[]): boolean {
  try {
    execFileSync("git", args, {
      cwd: memoryDir,
      stdio: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch (e) {
    if ((e as any)?.killed) {
      log.warn({ args, memoryDir }, "Git command timed out — skipping");
    }
    return false;
  }
}

/** Initialize a git repo in the memory directory if one doesn't exist. */
export function initMemoryRepo(memoryDir: string): boolean {
  if (existsSync(join(memoryDir, ".git"))) return false;

  try {
    gitSilent(memoryDir, ["init"]);
    gitSilent(memoryDir, ["config", "user.name", "Brainstorm"]);
    gitSilent(memoryDir, ["config", "user.email", "agent@brainstorm.co"]);
    gitSilent(memoryDir, ["add", "-A"]);
    gitSilent(memoryDir, [
      "commit",
      "-m",
      "init: memory repository",
      "--allow-empty",
    ]);
    log.info({ dir: memoryDir }, "Memory git repo initialized");
    return true;
  } catch (e) {
    log.warn({ err: e }, "Failed to initialize memory git repo");
    return false;
  }
}

/** Commit all changes in the memory directory. */
export function commitMemoryChange(
  memoryDir: string,
  message: string,
  author?: string,
): boolean {
  if (!existsSync(join(memoryDir, ".git"))) return false;

  try {
    gitSilent(memoryDir, ["add", "-A"]);

    const status = git(memoryDir, ["status", "--porcelain"]).trim();
    if (!status) return false;

    const args = ["commit", "-m", message];
    if (author) {
      args.push("--author", `${author} <agent@brainstorm.co>`);
    }
    gitSilent(memoryDir, args);
    return true;
  } catch {
    return false;
  }
}

/** Get memory change history. */
export function getMemoryHistory(
  memoryDir: string,
  limit = 20,
): Array<{
  hash: string;
  message: string;
  date: string;
  filesChanged: number;
}> {
  if (!existsSync(join(memoryDir, ".git"))) return [];

  try {
    const output = git(memoryDir, [
      "log",
      `--pretty=format:%H|%s|%ci`,
      "--shortstat",
      `-n`,
      String(limit),
    ]);

    const entries: Array<{
      hash: string;
      message: string;
      date: string;
      filesChanged: number;
    }> = [];
    const lines = output.split("\n").filter((l) => l.trim());

    let current: { hash: string; message: string; date: string } | null = null;
    for (const line of lines) {
      if (line.includes("|") && !line.startsWith(" ")) {
        if (current) entries.push({ ...current, filesChanged: 0 });
        const parts = line.split("|");
        current = {
          hash: parts[0].slice(0, 8),
          message: parts[1],
          date: parts[2],
        };
      } else if (current && line.includes("file")) {
        const match = line.match(/(\d+) files? changed/);
        entries.push({
          ...current,
          filesChanged: match ? parseInt(match[1]) : 0,
        });
        current = null;
      }
    }
    if (current) entries.push({ ...current, filesChanged: 0 });

    return entries;
  } catch {
    return [];
  }
}

/** Get diff of memory changes since a given ref. */
export function getMemoryDiff(memoryDir: string, since: string): string | null {
  if (!existsSync(join(memoryDir, ".git"))) return null;

  try {
    return git(memoryDir, ["diff", since, "--", "."]);
  } catch {
    return null;
  }
}
