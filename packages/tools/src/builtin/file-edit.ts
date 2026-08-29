import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
  statSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, relative } from "node:path";
import { homedir } from "node:os";
import { defineTool } from "../base.js";
import { getWorkspace } from "../workspace-context.js";
import { assertNotSensitivePathIncludingRealpath } from "./sensitive-paths.js";
import { applyEdit } from "./edit-common.js";

/**
 * Atomic file replace: write content to `<path>.tmp.<rand>`, fsync, then
 * rename over the target. Rename on POSIX is atomic within the same
 * filesystem, so a crash mid-write leaves either the OLD content or the
 * NEW content — never a partial write.
 *
 * v16 Chaos Monkey flagged that `writeFileSync(path, content)` is NOT
 * crash-safe: an ENOSPC mid-write or SIGKILL between open() and close()
 * truncates the file to a partial state. For an agent that edits its
 * own configuration / lockfile / migration file, that's data loss.
 *
 * The temp file is unlinked on any error in the write path, so we don't
 * leave debris on a full disk.
 */
function atomicReplaceFile(path: string, content: string): void {
  const tmp = `${path}.tmp.${randomBytes(6).toString("hex")}`;
  let fd: number | null = null;

  // v17 Attacker — atomicReplaceFile must preserve the target's
  // permission bits. Without this, editing a 0600 secret file
  // silently widens it to 0644 (Node's default writeFileSync mode)
  // because renameSync discards the target's pre-existing mode.
  // Capture the target's mode BEFORE writing tmp so we restore it
  // after the rename succeeds.
  let originalMode: number | undefined;
  try {
    if (existsSync(path)) {
      originalMode = statSync(path).mode & 0o777;
    }
  } catch {
    // If we can't stat the target, fall back to writing with default
    // mode — better than failing the edit. The downstream chmod will
    // be a no-op.
  }

  try {
    writeFileSync(tmp, content, {
      encoding: "utf-8",
      // If we captured the target's mode, create tmp with the same
      // mode so the file is never visible (between rename and chmod)
      // at a more-permissive mode than the original.
      ...(originalMode !== undefined ? { mode: originalMode } : {}),
    });
    // fsync the file so the bytes are durably on disk before we rename;
    // otherwise a crash AFTER rename can still produce a zero-byte file
    // on some filesystems.
    fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    // Belt-and-braces: rename keeps the SOURCE inode's perms, which we
    // already set via writeFileSync mode above. chmod is idempotent and
    // covers the case where filesystem umask masked the create-mode.
    if (originalMode !== undefined) {
      chmodSync(path, originalMode);
    }
  } catch (err) {
    // Cleanup: try to remove temp file and (if open) close the fd.
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}

function ensureSafePath(filePath: string): string {
  const cwd = getWorkspace();
  const resolved = resolve(cwd, filePath);
  const home = homedir();

  // Block credential files before the home-dir allowance — see
  // file-read.ts / sensitive-paths.ts for the rationale.
  const safetyPath = assertNotSensitivePathIncludingRealpath(resolved);

  // /var is NOT blocked because macOS tmpdir is /var/folders/... — see file-write.ts
  const isSafeTmpPath = (path: string) =>
    path.startsWith("/var/folders/") ||
    path.startsWith("/private/var/folders/") ||
    path.startsWith("/var/tmp/") ||
    path.startsWith("/private/var/tmp/") ||
    path === "/private/tmp" ||
    path.startsWith("/private/tmp/") ||
    // Linux tmpdir — see file-read.ts.
    path === "/tmp" ||
    path.startsWith("/tmp/");
  const pathsToCheck = Array.from(new Set([resolved, safetyPath]));
  if (
    pathsToCheck.some((path) => !isSafeTmpPath(path) && path.startsWith("/var"))
  ) {
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
  if (
    pathsToCheck.some((path) =>
      BLOCKED_PREFIXES.some((p) => path.startsWith(p)),
    )
  ) {
    throw new Error(`Path blocked: "${filePath}" is a protected system path`);
  }

  const isInHome = safetyPath.startsWith(home);
  const isInCwd = !relative(cwd, resolved).startsWith("..");
  const isSafeTmpVar = isSafeTmpPath(safetyPath);
  if (!isInHome && !isInCwd && !isSafeTmpVar) {
    throw new Error(
      `Path blocked: "${filePath}" is outside home directory and workspace`,
    );
  }

  return resolved;
}

/**
 * Find the closest matching substring in the file content.
 * Uses the first line of old_string to find candidate locations,
 * then returns surrounding context.
 */
function findClosestMatch(content: string, oldString: string): string | null {
  // Use the first non-empty line as a search anchor
  const lines = oldString.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const firstLine = lines[0].trim();
  if (firstLine.length < 5) return null; // Too short to be useful

  // Search for the first line (case-insensitive, trimmed)
  const contentLines = content.split("\n");
  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < contentLines.length; i++) {
    const trimmed = contentLines[i].trim();
    // Exact match of first line
    if (trimmed === firstLine) {
      bestIdx = i;
      bestScore = 100;
      break;
    }
    // Partial match — check if the line contains most of the search
    if (trimmed.includes(firstLine.slice(0, Math.min(30, firstLine.length)))) {
      if (bestScore < 50) {
        bestIdx = i;
        bestScore = 50;
      }
    }
  }

  if (bestIdx === -1) return null;

  // Return context: 2 lines before + match area + 2 lines after
  const numLines = oldString.split("\n").length;
  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(contentLines.length, bestIdx + numLines + 1);
  const context = contentLines.slice(start, end);

  return context.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
}

export const fileEditTool = defineTool({
  name: "file_edit",
  description:
    "Perform a surgical string replacement in a file. The old_string must match exactly one location. Returns { success, replacements } or { error }. Supports absolute paths within home directory.",
  permission: "confirm",
  inputSchema: z.object({
    path: z.string().describe("Path to the file to edit"),
    old_string: z.string().describe("The exact string to find and replace"),
    new_string: z.string().describe("The replacement string"),
  }),
  async execute({ path, old_string, new_string }) {
    let safePath: string;
    try {
      safePath = ensureSafePath(path);
    } catch (e: any) {
      return { error: e.message };
    }

    if (!existsSync(safePath)) {
      return { error: `File not found: ${path}` };
    }
    const content = readFileSync(safePath, "utf-8");

    // Route through the Aider-style fuzzy cascade in edit-common. This
    // handles the exact-unique path (fastest) plus whitespace-flexible,
    // ellipsis-elided and similarity-fallback matches — always $-safe and
    // never applying a low-confidence match. multi_edit/batch_edit share
    // the same applyEdit, so the whole edit surface benefits.
    const editResult = applyEdit(content, old_string, new_string);
    if (!editResult.applied || editResult.content === undefined) {
      if (editResult.occurrences && editResult.occurrences > 1) {
        return {
          error: `old_string found ${editResult.occurrences} times — must be unique. Provide more surrounding context.`,
        };
      }
      // Not found (below-confidence / ambiguous fuzzy) — offer a hint.
      const suggestion = findClosestMatch(content, old_string);
      if (suggestion) {
        return {
          error: "old_string not found in file",
          suggestion: `Closest match found:\n${suggestion}`,
        };
      }
      return { error: "old_string not found in file" };
    }

    // Snapshot before editing
    const { getCheckpointManager } = await import("../checkpoint.js");
    const cp = getCheckpointManager();
    if (cp) cp.snapshot(safePath);

    const updated = editResult.content;

    // Pre-validate content before writing (non-blocking)
    const { preValidate } = await import("../pre-validate.js");
    const validation = preValidate(safePath, updated);

    // Atomic replace — see atomicReplaceFile docstring. Closes v16
    // Chaos Monkey gap: partial-write on ENOSPC/SIGKILL no longer
    // possible.
    atomicReplaceFile(safePath, updated);

    // Invalidate read cache for this file
    const { getFileReadCache } = await import("../file-cache.js");
    getFileReadCache().invalidate(safePath);

    // Diff preview (non-blocking)
    const { getDiffSummary } = await import("../diff-preview.js");
    const diff = getDiffSummary(safePath);

    return {
      success: true,
      path,
      matchTier: editResult.matchTier,
      ...(validation.warnings.length > 0
        ? { preValidation: validation.warnings }
        : {}),
      ...(diff ? { diff: diff.preview } : {}),
    };
  },
});
