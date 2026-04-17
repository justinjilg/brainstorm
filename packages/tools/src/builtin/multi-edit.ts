import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { defineTool } from "../base.js";
import { applyEdits } from "./edit-common.js";
import { getWorkspace } from "../workspace-context.js";

function ensureSafePath(filePath: string): string {
  const cwd = getWorkspace();
  const resolved = resolve(cwd, filePath);
  const home = homedir();

  // Match file-write.ts/file-edit.ts: /var is NOT blocked wholesale because
  // macOS tmpdir lives at /var/folders/... (symlinked from /private/var/folders).
  // multi_edit previously blocked all of /var, so it refused to operate in
  // the same tmp workspace where file_write and file_edit worked fine — an
  // orchestration agent would get inconsistent results and loop.
  const isSafeTmpVar =
    resolved.startsWith("/var/folders/") ||
    resolved.startsWith("/private/var/folders/") ||
    resolved.startsWith("/var/tmp/") ||
    resolved.startsWith("/private/var/tmp/");
  if (!isSafeTmpVar && resolved.startsWith("/var")) {
    throw new Error(`Path blocked: "${filePath}" is a protected system path`);
  }
  const BLOCKED = ["/etc", "/usr", "/proc", "/sys", "/dev", "/sbin", "/boot"];
  if (BLOCKED.some((p) => resolved.startsWith(p))) {
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

export const multiEditTool = defineTool({
  name: "multi_edit",
  description:
    "Perform multiple find-and-replace edits in a single file atomically.",
  permission: "confirm",
  inputSchema: z.object({
    path: z.string().describe("Path to the file to edit"),
    edits: z
      .array(
        z.object({
          old_string: z.string().describe("Exact string to find"),
          new_string: z.string().describe("Replacement string"),
        }),
      )
      .describe("Array of find-and-replace operations"),
  }),
  async execute({ path, edits }) {
    let safePath: string;
    try {
      safePath = ensureSafePath(path);
    } catch (e: any) {
      return { error: e.message };
    }
    if (!existsSync(safePath)) return { error: `File not found: ${path}` };

    const original = readFileSync(safePath, "utf-8");
    const { content, results, appliedCount } = applyEdits(original, edits);

    if (appliedCount > 0) {
      const { getCheckpointManager } = await import("../checkpoint.js");
      const cp = getCheckpointManager();
      if (cp) cp.snapshot(safePath);
      // Atomic write: tmp file then rename. Clean up the tmp file on failure
      // so retries don't leave stale ".tmp" files in the user's directories
      // (matches file-write.ts's pattern).
      const tmpPath = `${safePath}.${randomUUID().slice(0, 8)}.tmp`;
      try {
        writeFileSync(tmpPath, content, "utf-8");
        renameSync(tmpPath, safePath);
      } catch (e) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* best-effort cleanup of temp file */
        }
        throw e;
      }
    }

    return {
      path: safePath,
      applied: appliedCount,
      total: edits.length,
      results,
    };
  },
});
