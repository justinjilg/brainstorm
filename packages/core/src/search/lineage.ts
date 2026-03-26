/**
 * Context Lineage — Git History Indexing.
 *
 * Parses recent commits to build a searchable commit history.
 * Summarizes each diff to a one-liner via regex (no LLM call).
 * Inspired by Augment Code's Context Lineage feature.
 */

import { execFileSync } from "node:child_process";

export interface CommitSummary {
  hash: string;
  date: string;
  author: string;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: string;
}

// Cache: indexed once per session, refreshed on demand
let _commitCache: {
  projectPath: string;
  commits: CommitSummary[];
  ts: number;
} | null = null;

const COMMIT_CACHE_TTL_MS = 120_000; // 2 minutes

/**
 * Index recent commits from git history.
 * Parses git log --stat output and generates one-line summaries via regex.
 */
export function indexRecentCommits(
  projectPath: string,
  maxCommits = 100,
): CommitSummary[] {
  if (
    _commitCache &&
    _commitCache.projectPath === projectPath &&
    Date.now() - _commitCache.ts < COMMIT_CACHE_TTL_MS
  ) {
    return _commitCache.commits;
  }

  try {
    const output = execFileSync(
      "git",
      [
        "log",
        `--max-count=${maxCommits}`,
        "--format=%H|%aI|%an|%s",
        "--stat",
        "--stat-width=200",
      ],
      {
        cwd: projectPath,
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const commits = parseGitLog(output);
    _commitCache = { projectPath, commits, ts: Date.now() };
    return commits;
  } catch {
    return [];
  }
}

function parseGitLog(output: string): CommitSummary[] {
  const commits: CommitSummary[] = [];
  const lines = output.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.includes("|")) {
      i++;
      continue;
    }

    // Parse header: hash|date|author|message
    const parts = line.split("|");
    if (parts.length < 4 || parts[0].length !== 40) {
      i++;
      continue;
    }

    const hash = parts[0];
    const date = parts[1];
    const author = parts[2];
    const message = parts.slice(3).join("|");
    i++;

    // Parse stat lines until blank line or summary line
    const changedFiles: string[] = [];
    let insertions = 0;
    let deletions = 0;

    while (i < lines.length && lines[i].trim() !== "") {
      const statLine = lines[i].trim();

      // Summary line: "N files changed, N insertions(+), N deletions(-)"
      const summaryMatch = statLine.match(
        /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
      );
      if (summaryMatch) {
        insertions = parseInt(summaryMatch[2] ?? "0", 10);
        deletions = parseInt(summaryMatch[3] ?? "0", 10);
        i++;
        break;
      }

      // File stat line: " path/to/file.ts | N +++---"
      const fileMatch = statLine.match(/^\s*(.+?)\s+\|\s+\d+/);
      if (fileMatch) {
        changedFiles.push(fileMatch[1].trim());
      }
      i++;
    }

    // Skip blank line
    while (i < lines.length && lines[i].trim() === "") i++;

    const summary = generateSummary(
      message,
      changedFiles,
      insertions,
      deletions,
    );
    commits.push({
      hash: hash.slice(0, 8),
      date,
      author,
      message,
      filesChanged: changedFiles.length,
      insertions,
      deletions,
      summary,
    });
  }

  return commits;
}

/**
 * Generate a one-line summary from commit metadata (no LLM).
 */
function generateSummary(
  message: string,
  files: string[],
  insertions: number,
  deletions: number,
): string {
  // Detect commit type from conventional commit prefix
  const typeMatch = message.match(
    /^(feat|fix|refactor|docs|test|chore|perf|ci|build)[\s(:]/i,
  );
  const type = typeMatch ? typeMatch[1].toLowerCase() : "change";

  // Detect primary area from file paths
  const areas = new Set<string>();
  for (const f of files.slice(0, 5)) {
    const parts = f.split("/");
    if (parts.length >= 2 && parts[0] === "packages") {
      areas.add(parts[1]);
    } else if (parts.length >= 1) {
      areas.add(parts[0]);
    }
  }

  const areaStr =
    areas.size > 0 ? ` in ${[...areas].slice(0, 3).join(", ")}` : "";
  const sizeStr =
    insertions + deletions > 100 ? ` (${insertions}+/${deletions}-)` : "";

  return `${type}${areaStr}: ${message.slice(0, 80)}${sizeStr}`;
}

/**
 * Search commit history using keyword matching on summaries and messages.
 */
export function searchCommitHistory(
  query: string,
  projectPath: string,
  topK = 5,
): CommitSummary[] {
  const commits = indexRecentCommits(projectPath);
  if (commits.length === 0) return [];

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const scored = commits.map((c) => {
    const text = `${c.message} ${c.summary}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (text.includes(term)) score++;
    }
    return { commit: c, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.commit);
}

/**
 * Format recent relevant commits as a context section for the system prompt.
 */
export function formatCommitContext(
  projectPath: string,
  maxCommits = 5,
): string | null {
  const commits = indexRecentCommits(projectPath, 50);
  if (commits.length === 0) return null;

  const recent = commits.slice(0, maxCommits);
  const lines = recent.map(
    (c) => `- ${c.hash} (${c.date.slice(0, 10)}): ${c.summary}`,
  );

  return lines.join("\n");
}
