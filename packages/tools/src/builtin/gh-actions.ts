import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub Actions tool — CI/CD workflow management via gh CLI.
 *
 * Enables agents to:
 * - Monitor CI status before merging PRs
 * - Trigger manual workflows
 * - Cancel/rerun failed runs
 * - Download build artifacts
 * - View workflow logs for debugging
 */
export const ghActionsTool = defineTool({
  name: "gh_actions",
  description:
    "GitHub Actions CI/CD management. Actions: workflows (list workflow definitions), runs (list recent runs with status), view-run (run details+jobs), trigger (dispatch workflow), cancel (stop a run), rerun (retry failed run), logs (download job logs), artifacts (list/download build artifacts).",
  permission: "confirm",
  inputSchema: z.object({
    action: z
      .enum([
        "workflows",
        "runs",
        "view-run",
        "trigger",
        "cancel",
        "rerun",
        "logs",
        "artifacts",
      ])
      .describe("Actions action"),
    // run-specific fields
    runId: z.number().optional().describe("Workflow run ID"),
    // trigger fields
    workflow: z
      .string()
      .optional()
      .describe("Workflow filename or ID (for trigger)"),
    ref: z.string().optional().describe("Branch/tag ref (for trigger)"),
    inputs: z
      .record(z.string())
      .optional()
      .describe("Workflow dispatch inputs (key-value pairs)"),
    // runs filter fields
    branch: z.string().optional().describe("Filter runs by branch"),
    status: z
      .enum([
        "queued",
        "in_progress",
        "completed",
        "success",
        "failure",
        "cancelled",
      ])
      .optional()
      .describe("Filter runs by status"),
    limit: z.number().optional().describe("Max items (default: 10)"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute(input) {
    const opts = { cwd: input.cwd ?? process.cwd() };

    try {
      switch (input.action) {
        case "workflows": {
          const { stdout } = await execFileAsync(
            "gh",
            ["workflow", "list", "--json", "id,name,state,path"],
            opts,
          );
          return { workflows: JSON.parse(stdout) };
        }

        case "runs": {
          const args = [
            "run",
            "list",
            "--json",
            "databaseId,displayTitle,status,conclusion,headBranch,createdAt,updatedAt,url,workflowName",
            "--limit",
            String(input.limit ?? 10),
          ];
          if (input.branch) args.push("--branch", input.branch);
          if (input.status) args.push("--status", input.status);
          if (input.workflow) args.push("--workflow", input.workflow);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { runs: JSON.parse(stdout) };
        }

        case "view-run": {
          if (!input.runId) return { error: "runId is required" };
          const { stdout } = await execFileAsync(
            "gh",
            [
              "run",
              "view",
              String(input.runId),
              "--json",
              "databaseId,displayTitle,status,conclusion,headBranch,jobs,createdAt,updatedAt,url",
            ],
            opts,
          );
          return { run: JSON.parse(stdout) };
        }

        case "trigger": {
          if (!input.workflow) return { error: "workflow is required" };
          const args = ["workflow", "run", input.workflow];
          if (input.ref) args.push("--ref", input.ref);
          if (input.inputs) {
            for (const [key, value] of Object.entries(input.inputs)) {
              args.push("--field", `${key}=${value}`);
            }
          }
          const { stdout } = await execFileAsync("gh", args, opts);
          return {
            success: true,
            output: stdout.trim() || "Workflow triggered",
          };
        }

        case "cancel": {
          if (!input.runId) return { error: "runId is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["run", "cancel", String(input.runId)],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        case "rerun": {
          if (!input.runId) return { error: "runId is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["run", "rerun", String(input.runId), "--failed"],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        case "logs": {
          if (!input.runId) return { error: "runId is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["run", "view", String(input.runId), "--log-failed"],
            { ...opts, maxBuffer: 5_000_000 },
          );
          // Truncate logs to prevent context overflow
          const maxLen = 50_000;
          const truncated = stdout.length > maxLen;
          return {
            logs: stdout.slice(0, maxLen),
            truncated,
            totalLength: stdout.length,
          };
        }

        case "artifacts": {
          if (!input.runId) return { error: "runId is required" };
          const { stdout } = await execFileAsync(
            "gh",
            [
              "api",
              `repos/{owner}/{repo}/actions/runs/${input.runId}/artifacts`,
              "--jq",
              ".artifacts[] | {id: .id, name: .name, size_in_bytes: .size_in_bytes, created_at: .created_at, expired: .expired}",
            ],
            opts,
          );
          const artifacts = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          return { artifacts };
        }

        default:
          return { error: `Unknown action: ${input.action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});
