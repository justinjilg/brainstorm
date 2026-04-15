/**
 * GitHub Repository Tools — repo info, branches, compare commits.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { GitHubClient } from "../client.js";

export function createRepoTools(
  client: GitHubClient,
  owner: string,
  repo: string,
): BrainstormToolDef[] {
  return [
    defineTool({
      name: "github_repo_info",
      description: `Get repository metadata for ${owner}/${repo}: languages, topics, default branch, visibility, size.`,
      permission: "auto" as const,
      inputSchema: z.object({}),
      async execute() {
        const data = await client.getRepo(owner, repo);
        return {
          name: data.full_name,
          description: data.description,
          language: data.language,
          topics: data.topics,
          defaultBranch: data.default_branch,
          visibility: data.visibility,
          size: data.size,
          openIssues: data.open_issues_count,
          updatedAt: data.updated_at,
        };
      },
    }),

    defineTool({
      name: "github_branches",
      description: `List branches for ${owner}/${repo} with protection status.`,
      permission: "auto" as const,
      inputSchema: z.object({}),
      async execute() {
        const branches = await client.listBranches(owner, repo);
        return branches.map((b: any) => ({
          name: b.name,
          protected: b.protected,
          sha: b.commit.sha.slice(0, 8),
        }));
      },
    }),

    defineTool({
      name: "github_compare",
      description: `Compare two git refs in ${owner}/${repo}. Shows changed files, commits, and stats.`,
      permission: "auto" as const,
      inputSchema: z.object({
        base: z.string().describe("Base ref (branch, tag, or SHA)"),
        head: z.string().describe("Head ref to compare against base"),
      }),
      async execute({ base, head }) {
        const data = await client.compareCommits(owner, repo, base, head);
        return {
          status: data.status,
          aheadBy: data.ahead_by,
          behindBy: data.behind_by,
          totalCommits: data.total_commits,
          files: (data.files ?? []).map((f: any) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
        };
      },
    }),
  ];
}
