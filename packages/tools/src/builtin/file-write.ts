import { z } from "zod";
import { writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { defineTool } from "../base.js";
import { getWorkspace } from "../workspace-context.js";

import { homedir } from "node:os";

function ensureSafePath(filePath: string): string {
  // Use the subagent's workspace context if set, else fall back to cwd.
  // This fixes SWE-bench / orchestration runs where the agent should write
  // into a cloned repo, not the parent CLI's working directory.
  const cwd = getWorkspace();
  const resolved = resolve(cwd, filePath);
  const home = homedir();

  // Block system paths.
  // Note: /var is NOT blocked because macOS tmpdir lives at /var/folders/...
  // (symlinked from /private/var/folders). We explicitly allow /var/folders
  // and /private/var/folders as temp workspaces; other /var/* stays blocked.
  const BLOCKED_PREFIXES = [
    "/etc",
    "/usr",
    "/proc",
    "/sys",
    "/dev",
    "/sbin",
    "/boot",
  ];
  // Extra /var handling: block unless inside /var/folders (macOS tmp)
  // or /var/tmp (Linux-ish tmp).
  const isSafeTmpVar =
    resolved.startsWith("/var/folders/") ||
    resolved.startsWith("/private/var/folders/") ||
    resolved.startsWith("/var/tmp/") ||
    resolved.startsWith("/private/var/tmp/");
  if (!isSafeTmpVar && resolved.startsWith("/var")) {
    throw new Error(`Path blocked: "${filePath}" is a protected system path`);
  }
  if (BLOCKED_PREFIXES.some((p) => resolved.startsWith(p))) {
    throw new Error(`Path blocked: "${filePath}" is a protected system path`);
  }

  // Allow within home dir, within cwd, or within a tmp workspace.
  // macOS symlinks /var/folders → /private/var/folders, so resolve() may
  // return either form depending on the OS resolver. Check both.
  const isInHome = resolved.startsWith(home);
  const isInCwd = !relative(cwd, resolved).startsWith("..");
  const isInTmp = isSafeTmpVar; // tmp workspaces are allowed too
  if (!isInHome && !isInCwd && !isInTmp) {
    throw new Error(
      `Path blocked: "${filePath}" is outside home directory and workspace`,
    );
  }

  return resolved;
}

export const fileWriteTool = defineTool({
  name: "file_write",
  description:
    "Write content to a file, creating it if it does not exist. Creates parent directories as needed. Supports absolute paths within home directory. Returns { success, path, bytesWritten } on success, { error } on failure.",
  permission: "confirm",
  inputSchema: z.object({
    path: z.string().describe("Path to the file to write"),
    content: z.string().describe("The content to write to the file"),
  }),
  async execute({ path, content }) {
    let safePath: string;
    try {
      safePath = ensureSafePath(path);
    } catch (e: any) {
      return { error: e.message };
    }

    // Snapshot before overwriting (if file exists)
    const { getCheckpointManager } = await import("../checkpoint.js");
    const cp = getCheckpointManager();
    if (cp) cp.snapshot(safePath);

    // Pre-validate content before writing (non-blocking)
    const { preValidate } = await import("../pre-validate.js");
    const validation = preValidate(safePath, content);

    mkdirSync(dirname(safePath), { recursive: true });

    // Atomic write: write to temp file, then rename to target.
    // Prevents partial writes on crash/interrupt.
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

    // Invalidate read cache for this file
    const { getFileReadCache } = await import("../file-cache.js");
    getFileReadCache().invalidate(safePath);

    // Track file access
    const { getFileTracker } = await import("../file-tracker.js");
    getFileTracker().recordWrite(safePath);

    // Track in active transaction
    const { recordTransactionFile } = await import("./transaction.js");
    recordTransactionFile(safePath);

    // Diff preview (non-blocking)
    const { getDiffSummary } = await import("../diff-preview.js");
    const diff = getDiffSummary(safePath);

    return {
      success: true,
      path,
      bytesWritten: Buffer.byteLength(content),
      ...(validation.warnings.length > 0
        ? { preValidation: validation.warnings }
        : {}),
      ...(diff ? { diff: diff.preview } : {}),
    };
  },
});
