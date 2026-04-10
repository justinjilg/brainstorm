import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { homedir } from "node:os";
import { defineTool } from "../base.js";
import { getWorkspace } from "../workspace-context.js";

function ensureSafePath(filePath: string): string {
  const cwd = getWorkspace();
  const resolved = resolve(cwd, filePath);
  const home = homedir();

  const BLOCKED_PREFIXES = [
    "/etc",
    "/usr",
    "/var",
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
  if (!isInHome && !isInCwd) {
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
    const occurrences = content.split(old_string).length - 1;

    if (occurrences === 0) {
      // Try to find the closest match for recovery
      const suggestion = findClosestMatch(content, old_string);
      if (suggestion) {
        return {
          error: "old_string not found in file",
          suggestion: `Closest match found:\n${suggestion}`,
        };
      }
      return { error: "old_string not found in file" };
    }
    if (occurrences > 1) {
      return {
        error: `old_string found ${occurrences} times — must be unique. Provide more surrounding context.`,
      };
    }

    // Snapshot before editing
    const { getCheckpointManager } = await import("../checkpoint.js");
    const cp = getCheckpointManager();
    if (cp) cp.snapshot(safePath);

    const updated = content.replace(old_string, new_string);

    // Pre-validate content before writing (non-blocking)
    const { preValidate } = await import("../pre-validate.js");
    const validation = preValidate(safePath, updated);

    writeFileSync(safePath, updated, "utf-8");

    // Invalidate read cache for this file
    const { getFileReadCache } = await import("../file-cache.js");
    getFileReadCache().invalidate(safePath);

    // Diff preview (non-blocking)
    const { getDiffSummary } = await import("../diff-preview.js");
    const diff = getDiffSummary(safePath);

    return {
      success: true,
      path,
      ...(validation.warnings.length > 0
        ? { preValidation: validation.warnings }
        : {}),
      ...(diff ? { diff: diff.preview } : {}),
    };
  },
});
