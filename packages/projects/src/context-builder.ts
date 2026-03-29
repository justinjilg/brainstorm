/**
 * Build project-specific context for injection into the system prompt.
 *
 * Combines: custom instructions + knowledge file summaries + project memory.
 * This is the Brainstorm equivalent of claude.ai's Project Instructions.
 */

import type { Project, ProjectMemoryEntry } from "@brainst0rm/shared";
import { existsSync, readFileSync } from "node:fs";

/**
 * Build a markdown section with project context for the system prompt.
 */
export function buildProjectContext(
  project: Project,
  memory: ProjectMemoryEntry[],
): string {
  const parts: string[] = [];

  parts.push(`# Active Project: ${project.name}`);
  parts.push(`Path: ${project.path}`);
  if (project.description) {
    parts.push(project.description);
  }

  // Custom instructions (the project's "system prompt override")
  if (project.customInstructions) {
    parts.push("");
    parts.push("## Project Instructions");
    parts.push(project.customInstructions);
  }

  // Knowledge files — read and include relevant ones
  if (project.knowledgeFiles.length > 0) {
    const knowledgeSections: string[] = [];
    for (const filePath of project.knowledgeFiles) {
      const fullPath = filePath.startsWith("/")
        ? filePath
        : `${project.path}/${filePath}`;

      if (!existsSync(fullPath)) continue;

      try {
        const content = readFileSync(fullPath, "utf-8");
        // Truncate large files
        const maxChars = 4000;
        const truncated =
          content.length > maxChars
            ? content.slice(0, maxChars) + "\n\n[... truncated]"
            : content;
        knowledgeSections.push(`### ${filePath}\n\n${truncated}`);
      } catch {
        // Skip unreadable files
      }
    }

    if (knowledgeSections.length > 0) {
      parts.push("");
      parts.push("## Project Knowledge");
      parts.push(...knowledgeSections);
    }
  }

  // Project memory — decisions, conventions, warnings
  if (memory.length > 0) {
    parts.push("");
    parts.push("## Project Memory");

    const byCategory = new Map<string, ProjectMemoryEntry[]>();
    for (const entry of memory) {
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }

    // Warnings first (most important)
    for (const cat of ["warning", "convention", "decision", "general"]) {
      const entries = byCategory.get(cat);
      if (!entries) continue;

      const label =
        cat === "warning"
          ? "Warnings"
          : cat === "convention"
            ? "Conventions"
            : cat === "decision"
              ? "Decisions"
              : "Notes";

      parts.push(`\n### ${label}`);
      for (const entry of entries) {
        parts.push(`- **${entry.key}**: ${entry.value}`);
      }
    }
  }

  // Budget context
  if (project.budgetDaily || project.budgetMonthly) {
    parts.push("");
    parts.push("## Budget");
    if (project.budgetDaily) {
      parts.push(`- Daily limit: $${project.budgetDaily.toFixed(2)}`);
    }
    if (project.budgetMonthly) {
      parts.push(`- Monthly limit: $${project.budgetMonthly.toFixed(2)}`);
    }
  }

  return parts.join("\n");
}
