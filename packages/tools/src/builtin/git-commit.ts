import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@brainst0rm/shared";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);
const log = createLogger("git-commit");

/**
 * Smart git commit tool with two modes:
 *
 * 1. **Analyze mode** (message omitted): Stages files, scans for credentials,
 *    then returns rich context (status, diff summary, recent commits) so the
 *    model can generate a contextual commit message.
 *
 * 2. **Commit mode** (message provided): Stages files, scans for credentials,
 *    and commits with the given message.
 *
 * Both modes enforce: explicit file paths only, credential scanning, and
 * optional Co-Authored-By attribution.
 */
export const gitCommitTool = defineTool({
  name: "git_commit",
  description:
    "Stage specific files and create a git commit. Two modes: (1) Omit `message` to get context for writing a good commit message (status, diff summary, recent commits). (2) Provide `message` to commit directly. Always scans for credentials before committing. Never stages all files — explicit paths required.",
  permission: "confirm",
  inputSchema: z.object({
    message: z
      .string()
      .optional()
      .describe(
        "Commit message (what + why). Omit to get context for generating a message. When provided, should summarize the change and explain motivation.",
      ),
    files: z
      .array(z.string())
      .min(1)
      .describe(
        'Files to stage — explicit paths required (no wildcards, no "all")',
      ),
    cwd: z.string().optional().describe("Working directory"),
    coAuthors: z
      .array(z.string())
      .optional()
      .describe('Co-author lines to append (format: "Name <email>")'),
  }),
  async execute({ message, files, cwd, coAuthors }) {
    const opts = { cwd: cwd ?? process.cwd() };

    try {
      // Stage specific files only (never git add -A)
      await execFileAsync("git", ["add", ...files], opts);

      // Scan staged diff for credentials before committing
      const { stdout: diff } = await execFileAsync(
        "git",
        ["diff", "--cached", "--unified=0"],
        opts,
      );
      const credentialHits = scanDiffForCredentials(diff);
      if (credentialHits.length > 0) {
        // Unstage and abort
        await execFileAsync("git", ["reset", "HEAD", ...files], opts).catch(
          (e) => {
            log.warn(
              { err: e },
              "Failed to unstage files after credential detection",
            );
          },
        );
        return {
          error: `Credential detected in staged changes — commit blocked.\n${credentialHits.map((h) => `  ${h.file}: ${h.pattern} (${h.preview})`).join("\n")}\n\nRemove the credential before committing.`,
        };
      }

      // Analyze mode: gather context for the model to generate a commit message
      if (!message) {
        const context = await gatherCommitContext(opts);
        return {
          needsMessage: true,
          context,
          stagedFiles: files,
          hint: "Use this context to write a commit message (what + why), then call git_commit again with the message.",
        };
      }

      // Build full commit message with optional co-authors
      const fullMessage = buildCommitMessage(message, coAuthors);

      // Commit
      const { stdout } = await execFileAsync(
        "git",
        ["commit", "-m", fullMessage],
        opts,
      );
      return { success: true, output: stdout.trim() };
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});

/**
 * Gather context to help generate a good commit message:
 * - git status (staged vs unstaged overview)
 * - git diff --cached --stat (what changed, file-level summary)
 * - git diff --cached (actual changes, truncated for large diffs)
 * - git log --oneline -5 (recent commit style reference)
 */
async function gatherCommitContext(opts: {
  cwd: string;
}): Promise<{
  status: string;
  diffStat: string;
  diffPreview: string;
  recentCommits: string;
}> {
  const MAX_DIFF_CHARS = 8000;

  const [statusResult, diffStatResult, diffResult, logResult] =
    await Promise.all([
      execFileAsync("git", ["status", "--short"], opts).catch(() => ({
        stdout: "",
      })),
      execFileAsync("git", ["diff", "--cached", "--stat"], opts).catch(() => ({
        stdout: "",
      })),
      execFileAsync("git", ["diff", "--cached"], opts).catch(() => ({
        stdout: "",
      })),
      execFileAsync("git", ["log", "--oneline", "-5"], opts).catch(() => ({
        stdout: "",
      })),
    ]);

  let diffPreview = diffResult.stdout;
  if (diffPreview.length > MAX_DIFF_CHARS) {
    diffPreview =
      diffPreview.slice(0, MAX_DIFF_CHARS) +
      `\n\n... truncated (${diffPreview.length} total chars)`;
  }

  return {
    status: statusResult.stdout.trim(),
    diffStat: diffStatResult.stdout.trim(),
    diffPreview: diffPreview.trim(),
    recentCommits: logResult.stdout.trim(),
  };
}

/**
 * Build the final commit message with optional Co-Authored-By trailers.
 */
function buildCommitMessage(message: string, coAuthors?: string[]): string {
  if (!coAuthors || coAuthors.length === 0) return message;

  const trailers = coAuthors
    .map((author) => `Co-Authored-By: ${author}`)
    .join("\n");
  return `${message}\n\n${trailers}`;
}

// --- Credential scanning (unchanged from PR #1) ---

interface CredentialHit {
  file: string;
  pattern: string;
  preview: string;
}

const CREDENTIAL_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub Token", pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: "OpenAI/Anthropic Key", pattern: /sk-(?:ant-)?[A-Za-z0-9-]{20,}/ },
  { name: "Stripe Key", pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  {
    name: "PEM Private Key",
    pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  },
  { name: "BR API Key", pattern: /br_(?:live|test)_[A-Za-z0-9]{20,}/ },
  {
    name: "Generic Secret",
    pattern:
      /(?:password|token|api_key|apikey|secret)\s*[:=]\s*['"]([^'"]{8,})['"]/i,
  },
];

function scanDiffForCredentials(diff: string): CredentialHit[] {
  const hits: CredentialHit[] = [];
  let currentFile = "";

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(.+)$/);
      currentFile = match?.[1] ?? "";
      continue;
    }
    // Only scan added lines (not removed)
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    for (const { name, pattern } of CREDENTIAL_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({
          file: currentFile,
          pattern: name,
          preview: line.slice(1, 60) + (line.length > 60 ? "..." : ""),
        });
      }
    }
  }
  return hits;
}
