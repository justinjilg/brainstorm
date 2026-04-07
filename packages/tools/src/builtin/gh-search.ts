import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub Search tool — cross-repo code, issue, and commit search.
 *
 * Critical for context gathering — find related code, prior issues,
 * and commit history across the entire GitHub ecosystem.
 */
export const ghSearchTool = defineTool({
  name: "gh_search",
  description:
    "GitHub search across repos. Actions: code (find code by content/filename/language), issues (search issues+PRs with filters), commits (search commit messages), repos (find repositories by topic/language/stars), prs (search pull requests specifically).",
  permission: "auto",
  readonly: true,
  inputSchema: z.object({
    action: z
      .enum(["code", "issues", "commits", "repos", "prs"])
      .describe("Search type"),
    query: z.string().describe("Search query (GitHub search syntax)"),
    // common filters
    repo: z.string().optional().describe("Limit to repo (owner/repo)"),
    owner: z.string().optional().describe("Limit to owner/org"),
    language: z.string().optional().describe("Filter by language"),
    // code-specific
    filename: z.string().optional().describe("Filter by filename"),
    extension: z.string().optional().describe("Filter by file extension"),
    // issue-specific
    state: z.enum(["open", "closed"]).optional().describe("Filter by state"),
    label: z.string().optional().describe("Filter by label"),
    // common
    limit: z.number().optional().describe("Max results (default: 10)"),
    sort: z.string().optional().describe("Sort field"),
    order: z.enum(["asc", "desc"]).optional().describe("Sort order"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute(input) {
    const opts = { cwd: input.cwd ?? process.cwd() };

    try {
      // Build the query with filters
      let q = input.query;
      if (input.repo) q += ` repo:${input.repo}`;
      if (input.owner) q += ` org:${input.owner}`;
      if (input.language) q += ` language:${input.language}`;

      switch (input.action) {
        case "code": {
          if (input.filename) q += ` filename:${input.filename}`;
          if (input.extension) q += ` extension:${input.extension}`;
          const { stdout } = await execFileAsync(
            "gh",
            [
              "search",
              "code",
              q,
              "--json",
              "repository,path,textMatches",
              "--limit",
              String(input.limit ?? 10),
            ],
            opts,
          );
          return { results: JSON.parse(stdout) };
        }

        case "issues": {
          if (input.state) q += ` state:${input.state}`;
          if (input.label) q += ` label:${input.label}`;
          q += " is:issue";
          const args = [
            "search",
            "issues",
            q,
            "--json",
            "number,title,state,repository,author,labels,url,createdAt",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.sort) args.push("--sort", input.sort);
          if (input.order) args.push("--order", input.order);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { results: JSON.parse(stdout) };
        }

        case "prs": {
          if (input.state) q += ` state:${input.state}`;
          if (input.label) q += ` label:${input.label}`;
          q += " is:pr";
          const args = [
            "search",
            "prs",
            q,
            "--json",
            "number,title,state,repository,author,labels,url,createdAt",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.sort) args.push("--sort", input.sort);
          if (input.order) args.push("--order", input.order);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { results: JSON.parse(stdout) };
        }

        case "commits": {
          const args = [
            "search",
            "commits",
            q,
            "--json",
            "sha,commit,repository,url",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.sort) args.push("--sort", input.sort);
          if (input.order) args.push("--order", input.order);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { results: JSON.parse(stdout) };
        }

        case "repos": {
          const args = [
            "search",
            "repos",
            q,
            "--json",
            "fullName,description,stargazersCount,language,url,updatedAt,isArchived",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.sort) args.push("--sort", input.sort);
          if (input.order) args.push("--order", input.order);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { results: JSON.parse(stdout) };
        }

        default:
          return { error: `Unknown action: ${input.action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});
