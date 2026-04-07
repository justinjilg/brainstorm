import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub Repository tool — repo metadata, collaborators, and branch protection.
 *
 * Enables agents to understand the repo environment: who has access,
 * what branches are protected, merge requirements, and repo settings.
 */
export const ghRepoTool = defineTool({
  name: "gh_repo",
  description:
    "GitHub repository management. Actions: info (repo metadata, visibility, default branch), collaborators (list with permission levels), branch-protection (view rules for a branch), topics (list/set repo topics), labels (list/create/delete labels), milestones (list/create milestones), fork (fork a repo), clone-url (get clone URLs).",
  permission: "auto",
  readonly: true,
  inputSchema: z.object({
    action: z
      .enum([
        "info",
        "collaborators",
        "branch-protection",
        "topics",
        "labels",
        "milestones",
        "fork",
        "clone-url",
      ])
      .describe("Repo action"),
    // repo identifier (defaults to current repo)
    repo: z.string().optional().describe("Repository (owner/repo)"),
    // branch-protection
    branch: z
      .string()
      .optional()
      .describe("Branch name (for branch-protection)"),
    // topics
    setTopics: z
      .array(z.string())
      .optional()
      .describe("Set topics (replaces existing)"),
    // labels
    labelName: z.string().optional().describe("Label name"),
    labelColor: z.string().optional().describe("Label color hex (without #)"),
    labelDescription: z.string().optional().describe("Label description"),
    // milestones
    milestoneTitle: z.string().optional().describe("Milestone title"),
    milestoneDueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    // common
    limit: z.number().optional().describe("Max items (default: 20)"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute(input) {
    const opts = { cwd: input.cwd ?? process.cwd() };
    const repoFlag = input.repo ? ["--repo", input.repo] : [];

    try {
      switch (input.action) {
        case "info": {
          const { stdout } = await execFileAsync(
            "gh",
            [
              "repo",
              "view",
              ...repoFlag,
              "--json",
              "name,owner,description,url,defaultBranchRef,isPrivate,isFork,stargazerCount,forkCount,diskUsage,languages,licenseInfo,createdAt,pushedAt,homepageUrl",
            ],
            opts,
          );
          return { repo: JSON.parse(stdout) };
        }

        case "collaborators": {
          const { stdout } = await execFileAsync(
            "gh",
            [
              "api",
              input.repo
                ? `repos/${input.repo}/collaborators`
                : "repos/{owner}/{repo}/collaborators",
              "--jq",
              ".[] | {login: .login, role: .role_name, permissions: .permissions}",
            ],
            opts,
          );
          const collaborators = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          return { collaborators };
        }

        case "branch-protection": {
          const br = input.branch ?? "main";
          const { stdout } = await execFileAsync(
            "gh",
            [
              "api",
              input.repo
                ? `repos/${input.repo}/branches/${br}/protection`
                : `repos/{owner}/{repo}/branches/${br}/protection`,
            ],
            opts,
          );
          return { protection: JSON.parse(stdout) };
        }

        case "topics": {
          if (input.setTopics) {
            // Set topics (mutating) — use --raw-field for JSON array
            const { stdout } = await execFileAsync(
              "gh",
              [
                "api",
                input.repo
                  ? `repos/${input.repo}/topics`
                  : "repos/{owner}/{repo}/topics",
                "--method",
                "PUT",
                "--raw-field",
                `names=${JSON.stringify(input.setTopics)}`,
              ],
              opts,
            );
            return { success: true, topics: JSON.parse(stdout) };
          }
          // List topics
          const { stdout } = await execFileAsync(
            "gh",
            [
              "api",
              input.repo
                ? `repos/${input.repo}/topics`
                : "repos/{owner}/{repo}/topics",
              "--jq",
              ".names",
            ],
            opts,
          );
          return { topics: JSON.parse(stdout) };
        }

        case "labels": {
          if (input.labelName && input.labelColor) {
            // Create label (mutating)
            const { stdout } = await execFileAsync(
              "gh",
              [
                "api",
                input.repo
                  ? `repos/${input.repo}/labels`
                  : "repos/{owner}/{repo}/labels",
                "--method",
                "POST",
                "--field",
                `name=${input.labelName}`,
                "--field",
                `color=${input.labelColor}`,
                "--field",
                `description=${input.labelDescription ?? ""}`,
              ],
              opts,
            );
            return { success: true, label: JSON.parse(stdout) };
          }
          // List labels
          const { stdout } = await execFileAsync(
            "gh",
            [
              "api",
              input.repo
                ? `repos/${input.repo}/labels`
                : "repos/{owner}/{repo}/labels",
              "--jq",
              ".[] | {name: .name, color: .color, description: .description}",
            ],
            opts,
          );
          const labels = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          return { labels: labels.slice(0, input.limit ?? 20) };
        }

        case "milestones": {
          if (input.milestoneTitle) {
            // Create milestone (mutating)
            const args = [
              "api",
              input.repo
                ? `repos/${input.repo}/milestones`
                : "repos/{owner}/{repo}/milestones",
              "--method",
              "POST",
              "--field",
              `title=${input.milestoneTitle}`,
            ];
            if (input.milestoneDueDate) {
              args.push(
                "--field",
                `due_on=${input.milestoneDueDate}T00:00:00Z`,
              );
            }
            const { stdout } = await execFileAsync("gh", args, opts);
            return { success: true, milestone: JSON.parse(stdout) };
          }
          // List milestones
          const { stdout } = await execFileAsync(
            "gh",
            [
              "api",
              input.repo
                ? `repos/${input.repo}/milestones`
                : "repos/{owner}/{repo}/milestones",
              "--jq",
              ".[] | {number: .number, title: .title, state: .state, open_issues: .open_issues, closed_issues: .closed_issues, due_on: .due_on}",
            ],
            opts,
          );
          const milestones = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          return { milestones };
        }

        case "fork": {
          const args = ["repo", "fork", ...repoFlag, "--clone=false"];
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, output: stdout.trim() };
        }

        case "clone-url": {
          const { stdout } = await execFileAsync(
            "gh",
            ["repo", "view", ...repoFlag, "--json", "sshUrl,url"],
            opts,
          );
          return JSON.parse(stdout);
        }

        default:
          return { error: `Unknown action: ${input.action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});
