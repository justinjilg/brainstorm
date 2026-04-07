import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub Code Review tool — full review workflow via gh CLI + API.
 *
 * Actions: list, create, approve, request-changes, comment, view-comments
 *
 * The most impactful GitHub capability for AI agents — enables:
 * - Reviewing PRs with structured feedback
 * - Approving PRs that pass review
 * - Requesting changes with specific inline comments
 * - Commenting on specific lines of code
 */
export const ghReviewTool = defineTool({
  name: "gh_review",
  description:
    "GitHub code review workflow. Actions: list (reviews on a PR), create (submit review with comment/approve/request-changes), approve (shortcut), request-changes (shortcut with body), comment (add inline or general comment on PR review), view-comments (see review comments on a PR).",
  permission: "confirm",
  inputSchema: z.object({
    action: z
      .enum([
        "list",
        "create",
        "approve",
        "request-changes",
        "comment",
        "view-comments",
      ])
      .describe("Review action"),
    number: z.number().describe("PR number"),
    // create fields
    event: z
      .enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"])
      .optional()
      .describe("Review event type (for create)"),
    body: z.string().optional().describe("Review body (markdown)"),
    // comment fields — for inline review comments via API
    path: z.string().optional().describe("File path for inline comment"),
    line: z
      .number()
      .optional()
      .describe("Line number in the diff for inline comment"),
    side: z
      .enum(["LEFT", "RIGHT"])
      .optional()
      .describe("Side of the diff (LEFT=old, RIGHT=new)"),
    commentBody: z.string().optional().describe("Inline comment text"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute(input) {
    const opts = { cwd: input.cwd ?? process.cwd() };
    const num = String(input.number);

    try {
      switch (input.action) {
        case "list": {
          const { stdout } = await execFileAsync(
            "gh",
            [
              "api",
              `repos/{owner}/{repo}/pulls/${num}/reviews`,
              "--jq",
              ".[] | {id: .id, user: .user.login, state: .state, body: .body, submitted_at: .submitted_at}",
            ],
            opts,
          );
          // Parse JSONL output
          const reviews = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          return { reviews };
        }

        case "create": {
          const args = ["pr", "review", num];
          const event = input.event ?? "COMMENT";
          switch (event) {
            case "APPROVE":
              args.push("--approve");
              break;
            case "REQUEST_CHANGES":
              args.push("--request-changes");
              break;
            case "COMMENT":
              args.push("--comment");
              break;
          }
          if (input.body) args.push("--body", input.body);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, output: stdout.trim() };
        }

        case "approve": {
          const args = ["pr", "review", num, "--approve"];
          if (input.body) args.push("--body", input.body);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, output: stdout.trim() };
        }

        case "request-changes": {
          if (!input.body)
            return { error: "body is required for request-changes" };
          const { stdout } = await execFileAsync(
            "gh",
            ["pr", "review", num, "--request-changes", "--body", input.body],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        case "comment": {
          if (!input.commentBody) return { error: "commentBody is required" };
          if (input.path && input.line) {
            // Inline review comment via API
            const { stdout } = await execFileAsync(
              "gh",
              [
                "api",
                `repos/{owner}/{repo}/pulls/${num}/comments`,
                "--method",
                "POST",
                "--field",
                `body=${input.commentBody}`,
                "--field",
                `path=${input.path}`,
                "--field",
                `line=${input.line}`,
                "--field",
                `side=${input.side ?? "RIGHT"}`,
              ],
              opts,
            );
            return { success: true, comment: JSON.parse(stdout) };
          }
          // General PR comment
          const { stdout } = await execFileAsync(
            "gh",
            ["pr", "comment", num, "--body", input.commentBody],
            opts,
          );
          return { success: true, url: stdout.trim() };
        }

        case "view-comments": {
          const { stdout } = await execFileAsync(
            "gh",
            [
              "api",
              `repos/{owner}/{repo}/pulls/${num}/comments`,
              "--jq",
              ".[] | {id: .id, user: .user.login, body: .body, path: .path, line: .line, created_at: .created_at}",
            ],
            opts,
          );
          const comments = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          return { comments };
        }

        default:
          return { error: `Unknown action: ${input.action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});
