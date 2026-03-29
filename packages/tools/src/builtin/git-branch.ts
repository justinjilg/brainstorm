import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

const PROTECTED_BRANCHES = new Set(["main", "master", "production", "release"]);

export const gitBranchTool = defineTool({
  name: "git_branch",
  description:
    "Manage git branches — create, switch, delete, or list. Protects main/master from deletion. Warns about uncommitted changes before switching.",
  permission: "confirm",
  inputSchema: z.object({
    action: z
      .enum(["create", "switch", "delete", "list"])
      .describe("Branch action"),
    name: z
      .string()
      .optional()
      .describe("Branch name (required for create/switch/delete)"),
    startPoint: z
      .string()
      .optional()
      .describe("Starting point for new branch (default: HEAD)"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute({ action, name, startPoint, cwd }) {
    const opts = { cwd: cwd ?? process.cwd() };

    try {
      switch (action) {
        case "create":
          return await createBranch(name, startPoint, opts);
        case "switch":
          return await switchBranch(name, opts);
        case "delete":
          return await deleteBranch(name, opts);
        case "list":
          return await listBranches(opts);
        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (err: any) {
      return { error: err.stderr || err.message };
    }
  },
});

async function createBranch(
  name: string | undefined,
  startPoint: string | undefined,
  opts: { cwd: string },
) {
  if (!name) return { error: 'name is required for "create" action' };

  const args = ["checkout", "-b", name];
  if (startPoint) args.push(startPoint);

  const { stdout } = await execFileAsync("git", args, opts);
  return { success: true, branch: name, output: stdout.trim() };
}

async function switchBranch(name: string | undefined, opts: { cwd: string }) {
  if (!name) return { error: 'name is required for "switch" action' };

  // Check for uncommitted changes
  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--porcelain"],
    opts,
  );
  if (status.trim()) {
    return {
      error:
        "Uncommitted changes detected. Stash or commit them first (use git_stash).",
      uncommittedFiles: status.trim().split("\n").length,
      status: status.trim(),
    };
  }

  const { stdout } = await execFileAsync("git", ["checkout", name], opts);
  return { success: true, branch: name, output: stdout.trim() };
}

async function deleteBranch(name: string | undefined, opts: { cwd: string }) {
  if (!name) return { error: 'name is required for "delete" action' };

  if (PROTECTED_BRANCHES.has(name)) {
    return {
      error: `Cannot delete protected branch "${name}". Protected branches: ${[...PROTECTED_BRANCHES].join(", ")}`,
    };
  }

  // Use -d (safe delete — only if fully merged)
  const { stdout } = await execFileAsync("git", ["branch", "-d", name], opts);
  return { success: true, deleted: name, output: stdout.trim() };
}

async function listBranches(opts: { cwd: string }) {
  const { stdout } = await execFileAsync(
    "git",
    [
      "branch",
      "-a",
      "--format=%(refname:short) %(objectname:short) %(upstream:short) %(HEAD)",
    ],
    opts,
  );

  const branches = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(" ");
      const isCurrent = parts[parts.length - 1] === "*";
      return {
        name: parts[0],
        commit: parts[1],
        upstream: parts[2] || null,
        current: isCurrent,
      };
    });

  return { branches };
}
