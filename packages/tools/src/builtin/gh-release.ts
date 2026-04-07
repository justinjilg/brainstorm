import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../base.js";

const execFileAsync = promisify(execFile);

/**
 * GitHub Release tool — release management via gh CLI.
 */
export const ghReleaseTool = defineTool({
  name: "gh_release",
  description:
    "GitHub release management. Actions: create (with auto-generated or custom notes), list, view, delete, upload (attach files to release), download (get release assets).",
  permission: "confirm",
  inputSchema: z.object({
    action: z
      .enum(["create", "list", "view", "delete", "upload", "download"])
      .describe("Release action"),
    // create fields
    tag: z.string().optional().describe("Tag name (e.g., v1.0.0)"),
    title: z.string().optional().describe("Release title"),
    notes: z.string().optional().describe("Release notes (markdown)"),
    target: z.string().optional().describe("Target branch/commit"),
    draft: z.boolean().optional().describe("Create as draft"),
    prerelease: z.boolean().optional().describe("Mark as prerelease"),
    generateNotes: z
      .boolean()
      .optional()
      .describe("Auto-generate notes from commits"),
    // upload/download fields
    files: z
      .array(z.string())
      .optional()
      .describe("File paths to upload as assets"),
    pattern: z.string().optional().describe("Glob pattern for download assets"),
    // view/delete fields — use tag
    limit: z.number().optional().describe("Max items (default: 10)"),
    cwd: z.string().optional().describe("Working directory"),
  }),
  async execute(input) {
    const opts = { cwd: input.cwd ?? process.cwd() };

    try {
      switch (input.action) {
        case "create": {
          if (!input.tag) return { error: "tag is required" };
          const args = ["release", "create", input.tag];
          if (input.title) args.push("--title", input.title);
          if (input.notes) args.push("--notes", input.notes);
          if (input.target) args.push("--target", input.target);
          if (input.draft) args.push("--draft");
          if (input.prerelease) args.push("--prerelease");
          if (input.generateNotes) args.push("--generate-notes");
          if (input.files?.length) args.push(...input.files);
          const { stdout } = await execFileAsync("gh", args, opts);
          return { success: true, url: stdout.trim() };
        }

        case "list": {
          const { stdout } = await execFileAsync(
            "gh",
            [
              "release",
              "list",
              "--json",
              "tagName,name,isDraft,isPrerelease,publishedAt,url",
              "--limit",
              String(input.limit ?? 10),
            ],
            opts,
          );
          return { releases: JSON.parse(stdout) };
        }

        case "view": {
          if (!input.tag) return { error: "tag is required" };
          const { stdout } = await execFileAsync(
            "gh",
            [
              "release",
              "view",
              input.tag,
              "--json",
              "tagName,name,body,isDraft,isPrerelease,publishedAt,assets,url,author",
            ],
            opts,
          );
          return { release: JSON.parse(stdout) };
        }

        case "delete": {
          if (!input.tag) return { error: "tag is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["release", "delete", input.tag, "--yes"],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        case "upload": {
          if (!input.tag) return { error: "tag is required" };
          if (!input.files?.length) return { error: "files is required" };
          const { stdout } = await execFileAsync(
            "gh",
            ["release", "upload", input.tag, ...input.files],
            opts,
          );
          return { success: true, output: stdout.trim() };
        }

        case "download": {
          if (!input.tag) return { error: "tag is required" };
          const args = ["release", "download", input.tag];
          if (input.pattern) args.push("--pattern", input.pattern);
          const { stdout } = await execFileAsync("gh", args, opts);
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
