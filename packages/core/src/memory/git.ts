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

// ── Remote Operations ─────────────────────────────────────────────

/** Configure a git remote for memory sync. Returns true if remote was added/updated. */
export function configureRemote(
  memoryDir: string,
  remoteUrl: string,
  remoteName = "origin",
): boolean {
  if (!existsSync(join(memoryDir, ".git"))) {
    initMemoryRepo(memoryDir);
  }

  try {
    // Check if remote already exists
    const existing = git(memoryDir, ["remote", "get-url", remoteName]).trim();
    if (existing === remoteUrl) return false; // already configured
    // Update existing remote
    gitSilent(memoryDir, ["remote", "set-url", remoteName, remoteUrl]);
    log.info({ remote: remoteName, url: remoteUrl }, "Memory remote updated");
    return true;
  } catch {
    // Remote doesn't exist — add it
    if (gitSilent(memoryDir, ["remote", "add", remoteName, remoteUrl])) {
      log.info({ remote: remoteName, url: remoteUrl }, "Memory remote added");
      return true;
    }
    return false;
  }
}

/** Check if a remote is configured. */
export function hasRemote(memoryDir: string, remoteName = "origin"): boolean {
  if (!existsSync(join(memoryDir, ".git"))) return false;
  try {
    git(memoryDir, ["remote", "get-url", remoteName]);
    return true;
  } catch {
    return false;
  }
}

export interface PullResult {
  success: boolean;
  conflicts: string[];
}

/** Pull changes from remote. Returns conflict info if merge fails. */
export function pullChanges(
  memoryDir: string,
  remoteName = "origin",
  branch = "main",
): PullResult {
  if (!existsSync(join(memoryDir, ".git"))) {
    return { success: false, conflicts: [] };
  }

  try {
    // Fetch first, then merge — more control than pull
    gitSilent(memoryDir, ["fetch", remoteName, branch]);
    gitSilent(memoryDir, ["merge", `${remoteName}/${branch}`, "--no-edit"]);
    return { success: true, conflicts: [] };
  } catch (err) {
    // Check for merge conflicts
    try {
      const status = git(memoryDir, ["status", "--porcelain"]);
      const conflicts = status
        .split("\n")
        .filter((l) => l.startsWith("UU ") || l.startsWith("AA "))
        .map((l) => l.slice(3).trim());

      if (conflicts.length > 0) {
        log.warn({ conflicts }, "Memory merge conflicts detected");
        return { success: false, conflicts };
      }
    } catch {
      // Can't even check status — return generic failure
    }

    log.warn({ err }, "Memory pull failed");
    return { success: false, conflicts: [] };
  }
}

/** Push committed changes to remote. */
export function pushChanges(
  memoryDir: string,
  remoteName = "origin",
  branch = "main",
): boolean {
  if (!existsSync(join(memoryDir, ".git"))) return false;
  return gitSilent(memoryDir, ["push", remoteName, branch]);
}

/**
 * Resolve merge conflicts using the specified strategy.
 * 'theirs' = last-writer-wins (matches gateway semantics).
 * 'ours' = keep local version.
 */
export function resolveConflicts(
  memoryDir: string,
  strategy: "ours" | "theirs",
): boolean {
  if (!existsSync(join(memoryDir, ".git"))) return false;

  try {
    const flag = strategy === "theirs" ? "--theirs" : "--ours";
    // Get list of conflicted files
    const status = git(memoryDir, ["status", "--porcelain"]);
    const conflicts = status
      .split("\n")
      .filter((l) => l.startsWith("UU ") || l.startsWith("AA "))
      .map((l) => l.slice(3).trim());

    if (conflicts.length === 0) return true;

    // Checkout the chosen side for each conflict
    for (const file of conflicts) {
      gitSilent(memoryDir, ["checkout", flag, "--", file]);
    }

    // Stage resolved files and commit
    gitSilent(memoryDir, ["add", "-A"]);
    gitSilent(memoryDir, [
      "commit",
      "-m",
      `resolve: memory merge conflicts (${strategy})`,
    ]);

    log.info(
      { strategy, files: conflicts.length },
      "Memory conflicts resolved",
    );
    return true;
  } catch (err) {
    log.error({ err }, "Failed to resolve memory conflicts");
    return false;
  }
}
