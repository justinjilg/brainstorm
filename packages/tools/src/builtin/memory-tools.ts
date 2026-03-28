/**
 * Letta-inspired Agent Memory Tools — give the agent explicit control
 * over its own persistent memory.
 *
 * Four tools:
 * - memory_save: store important information across sessions
 * - memory_search: recall previously saved information
 * - memory_list: list all saved memories by category
 * - memory_forget: remove outdated or incorrect memories
 *
 * These complement the existing middleware-based auto-extraction by
 * letting the agent deliberately decide what to remember.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "../base.js";

// ── Types for injection ─────────────────────────────────────────────

export interface MemoryBackend {
  /** Save to file-based memory (MemoryManager). */
  saveFile(entry: {
    type: "user" | "project" | "feedback" | "reference";
    name: string;
    description: string;
    content: string;
  }): void;
  /** Search file-based memory. */
  searchFiles(query: string): Array<{
    name: string;
    description: string;
    content: string;
    type: string;
  }>;
  /** List all file-based memories. */
  listFiles(): Array<{
    id: string;
    name: string;
    description: string;
    content: string;
    type: string;
  }>;
  /** Delete a file-based memory. */
  deleteFile(id: string): boolean;
  /** Save to project memory table (structured, SQLite). */
  saveProject(key: string, value: string, category: string): void;
  /** List project memories. */
  listProject(category?: string): Array<{
    key: string;
    value: string;
    category: string;
  }>;
  /** Delete from project memory. */
  deleteProject(key: string): void;
}

// ── Tool Factory ────────────────────────────────────────────────────

const BLOCK_TO_TYPE = {
  project: "project",
  user: "user",
  reference: "reference",
} as const;

/**
 * Create the 4 agent memory tools, injected with a memory backend.
 *
 * Called during session setup with the active MemoryManager + ProjectMemoryRepository.
 */
export function createMemoryTools(backend: MemoryBackend): BrainstormToolDef[] {
  const memorySaveTool = defineTool({
    name: "memory_save",
    description:
      "Save important information to persistent memory. Persists across sessions. Use for decisions, conventions, user preferences, warnings, or any fact worth remembering. The agent controls what to remember — be selective.",
    permission: "auto",
    inputSchema: z.object({
      key: z
        .string()
        .describe(
          "Short descriptive key (e.g., 'auth-pattern', 'user-prefers-typescript')",
        ),
      value: z.string().describe("The information to remember"),
      category: z
        .enum(["decision", "convention", "warning", "general"])
        .default("general")
        .describe(
          "Category: decision (architectural choice), convention (code pattern), warning (pitfall), general",
        ),
      block: z
        .enum(["project", "user", "reference"])
        .default("project")
        .describe(
          "Memory block: project (this codebase), user (preferences), reference (external info)",
        ),
    }),
    async execute({ key, value, category, block }) {
      const type = BLOCK_TO_TYPE[block] ?? "project";
      const slug = key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);

      // Write to both stores for redundancy
      backend.saveFile({
        type: type as "user" | "project" | "feedback" | "reference",
        name: key,
        description: `${category}: ${value.slice(0, 80)}`,
        content: value,
      });
      backend.saveProject(slug, value, category);

      return {
        saved: true,
        key: slug,
        category,
        block,
        message: `Remembered: "${key}" (${category})`,
      };
    },
  });

  const memorySearchTool = defineTool({
    name: "memory_search",
    description:
      "Search persistent memory for previously saved information. Use when you need to recall a decision, convention, or fact from a previous session.",
    permission: "auto",
    inputSchema: z.object({
      query: z.string().describe("What to search for"),
    }),
    async execute({ query }) {
      // Search both stores
      const fileResults = backend.searchFiles(query);
      const projectResults = backend.listProject().filter((m) => {
        const text = `${m.key} ${m.value}`.toLowerCase();
        return query
          .toLowerCase()
          .split(/\s+/)
          .some((term) => text.includes(term));
      });

      // Merge and deduplicate
      const seen = new Set<string>();
      const results: Array<{
        key: string;
        value: string;
        source: string;
        category?: string;
      }> = [];

      for (const r of projectResults) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        results.push({
          key: r.key,
          value: r.value,
          source: "project_memory",
          category: r.category,
        });
      }

      for (const r of fileResults) {
        const key = r.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          key: r.name,
          value: r.content,
          source: "file_memory",
        });
      }

      if (results.length === 0) {
        return { found: 0, message: "No memories found matching that query." };
      }

      return { found: results.length, results: results.slice(0, 10) };
    },
  });

  const memoryListTool = defineTool({
    name: "memory_list",
    description:
      "List all saved memories for the current project, optionally filtered by category.",
    permission: "auto",
    inputSchema: z.object({
      category: z
        .enum(["decision", "convention", "warning", "general", "all"])
        .default("all")
        .describe("Filter by category, or 'all' for everything"),
    }),
    async execute({ category }) {
      const cat = category === "all" ? undefined : category;
      const projectMemories = backend.listProject(cat);
      const fileMemories = backend.listFiles();

      // Merge, project memories take priority
      const seen = new Set(projectMemories.map((m) => m.key));
      const extras = fileMemories
        .filter((m) => !seen.has(m.id))
        .map((m) => ({
          key: m.name,
          value: m.content,
          category: m.type,
        }));

      const all = [...projectMemories, ...extras];

      if (all.length === 0) {
        return {
          count: 0,
          message:
            "No memories saved yet. Use memory_save to remember important information.",
        };
      }

      return { count: all.length, memories: all };
    },
  });

  const memoryForgetTool = defineTool({
    name: "memory_forget",
    description:
      "Remove a memory entry that is no longer relevant or accurate.",
    permission: "confirm",
    inputSchema: z.object({
      key: z.string().describe("The key of the memory to remove"),
    }),
    async execute({ key }) {
      const slug = key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);

      backend.deleteProject(slug);
      backend.deleteFile(slug);

      return { forgotten: true, key: slug, message: `Forgot: "${key}"` };
    },
  });

  return [memorySaveTool, memorySearchTool, memoryListTool, memoryForgetTool];
}
