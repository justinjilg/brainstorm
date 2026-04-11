import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { defineTool } from "../base.js";
import { getWorkspace } from "../workspace-context.js";

import { homedir } from "node:os";

function ensureSafePath(filePath: string): string {
  const cwd = getWorkspace();
  const resolved = resolve(cwd, filePath);
  const home = homedir();

  // Allow: paths within cwd OR within home directory OR safe tmp workspaces.
  // macOS tmpdir lives at /var/folders/... so /var is not blanket-blocked.
  const isSafeTmpVar =
    resolved.startsWith("/var/folders/") ||
    resolved.startsWith("/private/var/folders/") ||
    resolved.startsWith("/var/tmp/") ||
    resolved.startsWith("/private/var/tmp/");
  if (!isSafeTmpVar && resolved.startsWith("/var")) {
    throw new Error(`Path blocked: "${filePath}" is a protected system path`);
  }
  const BLOCKED_PREFIXES = [
    "/etc",
    "/usr",
    "/proc",
    "/sys",
    "/dev",
    "/sbin",
    "/boot",
  ];
  if (BLOCKED_PREFIXES.some((p) => resolved.startsWith(p))) {
    throw new Error(`Path blocked: "${filePath}" is a protected system path`);
  }

  const isInHome = resolved.startsWith(home);
  const isInCwd = !relative(cwd, resolved).startsWith("..");
  if (!isInHome && !isInCwd && !isSafeTmpVar) {
    throw new Error(
      `Path blocked: "${filePath}" is outside home directory and workspace`,
    );
  }

  return resolved;
}

export const fileReadTool = defineTool({
  name: "file_read",
  description:
    "Read the contents of a file. Supports absolute paths within the home directory (~/Projects, ~/Desktop, etc.) and relative paths within the project. Use `limit` and `offset` for large files — default reads the full file. Returns { content, totalLines } on success, { error } on failure.",
  permission: "auto",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path to the file to read"),
    limit: z.number().optional().describe("Maximum number of lines to read"),
    offset: z
      .number()
      .optional()
      .describe("Line number to start reading from (1-based)"),
  }),
  async execute({ path, limit, offset }) {
    let safePath: string;
    try {
      safePath = ensureSafePath(path);
    } catch (e: any) {
      return { error: e.message };
    }

    if (!existsSync(safePath)) {
      return { error: `File not found: ${path}` };
    }
    // Track file access
    const { getFileTracker } = await import("../file-tracker.js");
    getFileTracker().recordRead(safePath);

    // Check cache first to avoid redundant disk reads
    const { getFileReadCache } = await import("../file-cache.js");
    const cache = getFileReadCache();
    let content = cache.get(safePath);
    if (content === null) {
      content = readFileSync(safePath, "utf-8");
      cache.set(safePath, content);
    }
    const lines = content.split("\n");

    const start = (offset ?? 1) - 1;
    const end = limit ? start + limit : lines.length;
    const selected = lines.slice(start, end);

    return {
      content: selected
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join("\n"),
      totalLines: lines.length,
    };
  },
});
