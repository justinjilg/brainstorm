import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub PR tool — full pull request lifecycle via the gh CLI.
 * Requires `gh` to be installed and authenticated.
 *
 * Actions: create, list, view, merge, close, reopen, diff, checks, comment, ready
 */
export const ghPrTool = defineTool({
  name: "gh_pr",
  description:
    "Full GitHub pull request management. Actions: create (new PR), list (filter by state), view (details+files), merge (with strategy), close/reopen, diff (full patch), checks (CI status), comment (add discussion), ready (mark draft as ready for review).",
  permission: "confirm",
  inputSchema: z.object({
    action: z
      .enum([
        "create",
        "list",
        "view",
        "merge",
        "close",
        "reopen",
        "diff",
        "checks",
        "comment",
        "ready",
      ])
      .describe("PR action to perform"),
    // create fields
    title: z.string().optional().describe("PR title (< 70 chars)"),
    body: z.string().optional().describe("PR body (markdown)"),
    base: z.string().optional().describe("Base branch (default: main)"),
    draft: z.boolean().optional().describe("Create as draft PR"),
    reviewers: z
      .array(z.string())
      .optional()
      .describe("Request review from these users"),
    labels: z.array(z.string()).optional().describe("Labels to apply"),
    // view/merge/close/diff/checks/comment fields
    number: z.number().optional().describe("PR number"),
    // merge fields
    mergeMethod: z
      .enum(["merge", "squash", "rebase"])
      .optional()
      .describe("Merge strategy (default: merge)"),
    deleteAfterMerge: z
      .boolean()
      .optional()
      .describe("Delete branch after merge (default: true)"),
    // comment fields
    commentBody: z.string().optional().describe("Comment text (markdown)"),
    // list fields
    state: z
      .enum(["open", "closed", "merged", "all"])
      .optional()
      .describe("Filter by state"),
    limit: z.number().optional().describe("Max items (default: 10)"),
    author: z.string().optional().describe("Filter by author"),
    search: z.string().optional().describe("Search query for PRs"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute(input) {
    const opts = { cwd: input.cwd ?? process.cwd() };

    try {
      switch (input.action) {
        case "create": {
          if (!input.title) return { error: "title is required" };
          if (!input.body) return { error: "body is required" };
          const args = [
            "pr",
            "create",
            "--title",
            input.title,
            "--body",
            input.body,
          ];
          if (input.base) args.push("--base", input.base);
          if (input.draft) args.push("--draft");
          if (input.reviewers?.length)
            for (const r of input.reviewers) args.push("--reviewer", r);
          if (input.labels?.length)
            for (const l of input.labels) args.push("--label", l);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, url: stdout.trim() };
        }

        case "list": {
          const args = [
            "pr",
            "list",
            "--json",
            "number,title,state,author,url,headRefName,labels,isDraft,createdAt,updatedAt",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.state && input.state !== "all")
            args.push("--state", input.state);
          if (input.author) args.push("--author", input.author);
          if (input.search) args.push("--search", input.search);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { prs: JSON.parse(stdout) };
        }

        case "view": {
          if (!input.number) return { error: "number is required" };
          const { stdout } = await execFileAsync(
            "gh",
            [
              "pr",
              "view",
              String(input.number),
              "--json",
              "number,title,state,body,author,url,additions,deletions,files,reviewDecision,reviewRequests,labels,milestone,isDraft,mergeable,headRefName,baseRefName,commits",
            ],
            opts,
          );
          return { pr: JSON.parse(stdout) };
        }

        case "merge": {
          if (!input.number) return { error: "number is required" };
          const args = ["pr", "merge", String(input.number)];
          const method = input.mergeMethod ?? "merge";
          args.push(`--${method}`);
          if (input.deleteAfterMerge !== false) args.push("--delete-branch");
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, output: stdout.trim() };
        }

        case "close": {
          if (!input.number) return { error: "number is required" };
          const args = ["pr", "close", String(input.number)];
          if (input.commentBody) args.push("--comment", input.commentBody);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, output: stdout.trim() };
        }

        case "reopen": {
          if (!input.number) return { error: "number is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["pr", "reopen", String(input.number)],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        case "diff": {
          if (!input.number) return { error: "number is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["pr", "diff", String(input.number)],
            opts,
          );
          return { diff: stdout };
        }

        case "checks": {
          if (!input.number) return { error: "number is required" };
          const { stdout } = await execFileAsync(
            "gh",
            [
              "pr",
              "checks",
              String(input.number),
              "--json",
              "name,state,conclusion,startedAt,completedAt,detailsUrl",
            ],
            opts,
          );
          return { checks: JSON.parse(stdout) };
        }

        case "comment": {
          if (!input.number) return { error: "number is required" };
          if (!input.commentBody) return { error: "commentBody is required" };
          const { stdout } = await execFileAsync(
            "gh",
            [
              "pr",
              "comment",
              String(input.number),
              "--body",
              input.commentBody,
            ],
            opts,
          );
          return { success: true, url: stdout.trim() };
        }

        case "ready": {
          if (!input.number) return { error: "number is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["pr", "ready", String(input.number)],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        default:
          return { error: `Unknown action: ${input.action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});
