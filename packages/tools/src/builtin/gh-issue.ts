import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub Issue tool — full issue lifecycle via the gh CLI.
 * Requires `gh` to be installed and authenticated.
 *
 * Actions: create, list, view, comment, close, reopen, edit, label, assign, pin, transfer
 */
export const ghIssueTool = defineTool({
  name: "gh_issue",
  description:
    "Full GitHub issue management. Actions: create, list (filter by state/label/assignee/milestone), view (with comments), comment, close (with reason), reopen, edit (title/body), label (add/remove), assign (add/remove), pin/unpin, transfer (to another repo).",
  permission: "confirm",
  inputSchema: z.object({
    action: z
      .enum([
        "create",
        "list",
        "view",
        "comment",
        "close",
        "reopen",
        "edit",
        "label",
        "assign",
        "pin",
        "unpin",
        "transfer",
      ])
      .describe("Issue action to perform"),
    // create/edit fields
    title: z.string().optional().describe("Issue title"),
    body: z.string().optional().describe("Issue body (markdown)"),
    labels: z
      .array(z.string())
      .optional()
      .describe("Labels to apply (create) or add (label action)"),
    assignees: z.array(z.string()).optional().describe("Users to assign"),
    milestone: z.string().optional().describe("Milestone name or number"),
    // view/comment/close/edit/label/assign/pin fields
    number: z.number().optional().describe("Issue number"),
    // comment fields
    commentBody: z.string().optional().describe("Comment text (markdown)"),
    // close fields
    reason: z
      .enum(["completed", "not_planned"])
      .optional()
      .describe("Close reason"),
    // label action
    removeLabels: z
      .array(z.string())
      .optional()
      .describe("Labels to remove (label action)"),
    // transfer
    targetRepo: z
      .string()
      .optional()
      .describe("Target repo for transfer (owner/repo)"),
    // list fields
    state: z
      .enum(["open", "closed", "all"])
      .optional()
      .describe("Filter by state"),
    label: z.string().optional().describe("Filter by label"),
    assignee: z.string().optional().describe("Filter by assignee"),
    search: z.string().optional().describe("Search query"),
    limit: z.number().optional().describe("Max items (default: 10)"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute(input) {
    const opts = { cwd: input.cwd ?? process.cwd() };

    try {
      switch (input.action) {
        case "create": {
          if (!input.title) return { error: "title is required" };
          const args = ["issue", "create", "--title", input.title];
          if (input.body) args.push("--body", input.body);
          if (input.labels?.length)
            args.push("--label", input.labels.join(","));
          if (input.assignees?.length)
            args.push("--assignee", input.assignees.join(","));
          if (input.milestone) args.push("--milestone", input.milestone);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, url: stdout.trim() };
        }

        case "list": {
          const args = [
            "issue",
            "list",
            "--json",
            "number,title,state,author,labels,assignees,milestone,url,createdAt,updatedAt",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.state && input.state !== "all")
            args.push("--state", input.state);
          if (input.label) args.push("--label", input.label);
          if (input.assignee) args.push("--assignee", input.assignee);
          if (input.search) args.push("--search", input.search);
          if (input.milestone) args.push("--milestone", input.milestone);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { issues: JSON.parse(stdout) };
        }

        case "view": {
          if (!input.number) return { error: "number is required" };
          const { stdout } = await execFileAsync(
            "gh",
            [
              "issue",
              "view",
              String(input.number),
              "--json",
              "number,title,state,body,author,labels,assignees,milestone,url,comments,createdAt,closedAt",
            ],
            opts,
          );
          return { issue: JSON.parse(stdout) };
        }

        case "comment": {
          if (!input.number) return { error: "number is required" };
          if (!input.commentBody) return { error: "commentBody is required" };
          const { stdout } = await execFileAsync(
            "gh",
            [
              "issue",
              "comment",
              String(input.number),
              "--body",
              input.commentBody,
            ],
            opts,
          );
          return { success: true, url: stdout.trim() };
        }

        case "close": {
          if (!input.number) return { error: "number is required" };
          const args = ["issue", "close", String(input.number)];
          if (input.reason) args.push("--reason", input.reason);
          if (input.commentBody) args.push("--comment", input.commentBody);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, output: stdout.trim() };
        }

        case "reopen": {
          if (!input.number) return { error: "number is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["issue", "reopen", String(input.number)],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        case "edit": {
          if (!input.number) return { error: "number is required" };
          const args = ["issue", "edit", String(input.number)];
          if (input.title) args.push("--title", input.title);
          if (input.body) args.push("--body", input.body);
          if (input.milestone) args.push("--milestone", input.milestone);
          if (input.labels?.length)
            args.push("--add-label", input.labels.join(","));
          if (input.assignees?.length)
            args.push("--add-assignee", input.assignees.join(","));
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, output: stdout.trim() };
        }

        case "label": {
          if (!input.number) return { error: "number is required" };
          const args = ["issue", "edit", String(input.number)];
          if (input.labels?.length)
            args.push("--add-label", input.labels.join(","));
          if (input.removeLabels?.length)
            args.push("--remove-label", input.removeLabels.join(","));
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, output: stdout.trim() };
        }

        case "assign": {
          if (!input.number) return { error: "number is required" };
          if (!input.assignees?.length)
            return { error: "assignees is required" };
          const args = ["issue", "edit", String(input.number)];
          args.push("--add-assignee", input.assignees.join(","));
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, output: stdout.trim() };
        }

        case "pin": {
          if (!input.number) return { error: "number is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["issue", "pin", String(input.number)],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        case "unpin": {
          if (!input.number) return { error: "number is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["issue", "unpin", String(input.number)],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        case "transfer": {
          if (!input.number) return { error: "number is required" };
          if (!input.targetRepo) return { error: "targetRepo is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["issue", "transfer", String(input.number), input.targetRepo],
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
