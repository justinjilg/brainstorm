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
      // Note: repo/owner use --repo/--owner flags, not query string,
      // because gh CLI wraps the query and escapes colons in repo: syntax.
      let q = input.query;
      if (input.language) q += ` language:${input.language}`;
      const repoFlags: string[] = [];
      if (input.repo) repoFlags.push("--repo", input.repo);
      if (input.owner) repoFlags.push("--owner", input.owner);

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
              ...repoFlags,
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
          const issueArgs = [
            "search",
            "issues",
            q,
            ...repoFlags,
            "--json",
            "number,title,state,repository,author,labels,url,createdAt",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.sort) issueArgs.push("--sort", input.sort);
          if (input.order) issueArgs.push("--order", input.order);
          const { stdout: issueOut } = await execFileAsync(
            "gh",
            issueArgs,
            opts,
          );
          return { results: JSON.parse(issueOut) };
        }

        case "prs": {
          if (input.state) q += ` state:${input.state}`;
          if (input.label) q += ` label:${input.label}`;
          const prArgs = [
            "search",
            "prs",
            q,
            ...repoFlags,
            "--json",
            "number,title,state,repository,author,labels,url,createdAt",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.sort) prArgs.push("--sort", input.sort);
          if (input.order) prArgs.push("--order", input.order);
          const { stdout: prOut } = await execFileAsync("gh", prArgs, opts);
          return { results: JSON.parse(prOut) };
        }

        case "commits": {
          const commitArgs = [
            "search",
            "commits",
            q,
            ...repoFlags,
            "--json",
            "sha,commit,repository,url",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.sort) commitArgs.push("--sort", input.sort);
          if (input.order) commitArgs.push("--order", input.order);
          const { stdout: commitOut } = await execFileAsync(
            "gh",
            commitArgs,
            opts,
          );
          return { results: JSON.parse(commitOut) };
        }

        case "repos": {
          const repoArgs = [
            "search",
            "repos",
            q,
            ...repoFlags,
            "--json",
            "fullName,description,stargazersCount,language,url,updatedAt,isArchived",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.sort) repoArgs.push("--sort", input.sort);
          if (input.order) repoArgs.push("--order", input.order);
          const { stdout: repoOut } = await execFileAsync("gh", repoArgs, opts);
          return { results: JSON.parse(repoOut) };
        }

        default:
          return { error: `Unknown action: ${input.action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});
