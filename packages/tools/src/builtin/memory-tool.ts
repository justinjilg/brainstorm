/**
 * Memory Omni-Tool — agent-callable tool for reading, writing,
 * searching, promoting, and demoting memory entries at runtime.
 *
 * Operations:
 *   read    — Get full content of a memory entry
 *   write   — Create or update a memory entry
 *   search  — Search memories by query
 *   list    — List all memories (with tier info)
 *   promote — Move entry from archive to system (always in prompt)
 *   demote  — Move entry from system to archive (on-demand)
 *   delete  — Remove a memory entry
 */

import { z } from "zod";
import { defineTool } from "../base.js";

export const memoryTool = defineTool({
  name: "memory",
  description:
    "Read, write, search, and manage persistent memory. " +
    "Memory persists across sessions. System-tier entries are always in the prompt; " +
    "archive-tier entries are searchable on demand. " +
    "Operations: read, write, search, list, promote, demote, delete.",
  permission: "auto",
  inputSchema: z.object({
    operation: z
      .enum(["read", "write", "search", "list", "promote", "demote", "delete"])
      .describe("Memory operation to perform"),
    id: z
      .string()
      .optional()
      .describe("Memory entry ID (for read, promote, demote, delete)"),
    query: z
      .string()
      .optional()
      .describe("Search query (for search operation)"),
    name: z.string().optional().describe("Entry name (for write operation)"),
    description: z
      .string()
      .optional()
      .describe("One-line description (for write operation)"),
    content: z
      .string()
      .optional()
      .describe("Entry content (for write operation)"),
    type: z
      .enum(["user", "project", "feedback", "reference"])
      .optional()
      .describe(
        "Memory type (for write). user/feedback → system tier, project/reference → archive",
      ),
    tier: z
      .enum(["system", "archive"])
      .optional()
      .describe(
        "Override tier placement (for write). system = always in prompt",
      ),
    reason: z
      .string()
      .optional()
      .describe("Why this memory operation is being performed"),
  }),
  async execute(input) {
    // Memory tool is a stub that gets wired at runtime by the agent loop
    // because it needs access to the MemoryManager instance.
    // This definition provides the schema for LLM tool calling.
    return {
      error:
        "Memory tool not wired. This tool must be connected to a MemoryManager instance at runtime.",
    };
  },
});

/**
 * Create a memory tool wired to a specific MemoryManager.
 * Called during agent loop initialization.
 */
export function createWiredMemoryTool(manager: any) {
  return defineTool({
    name: "memory",
    description: memoryTool.description,
    permission: "auto",
    inputSchema: memoryTool.inputSchema,
    async execute(input) {
      switch (input.operation) {
        case "read": {
          if (!input.id) return { error: "id required for read" };
          const entry = manager.get(input.id);
          if (!entry) return { error: `Memory entry "${input.id}" not found` };
          return {
            id: entry.id,
            name: entry.name,
            type: entry.type,
            tier: entry.tier,
            description: entry.description,
            content: entry.content,
          };
        }

        case "write": {
          if (!input.name) return { error: "name required for write" };
          if (!input.content) return { error: "content required for write" };
          const entry = manager.save({
            name: input.name,
            description: input.description ?? "",
            content: input.content,
            type: input.type ?? "project",
            tier: input.tier,
            source: "agent_extraction" as const,
            author: "agent",
          });
          return {
            saved: true,
            id: entry.id,
            tier: entry.tier,
            trustScore: entry.trustScore,
            message:
              entry.tier === "quarantine"
                ? `Memory "${entry.name}" quarantined (low trust: ${entry.trustScore.toFixed(1)})`
                : `Memory "${entry.name}" saved to ${entry.tier}`,
          };
        }

        case "search": {
          if (!input.query) return { error: "query required for search" };
          const results = manager.search(input.query);
          return {
            results: results.map((m: any) => ({
              id: m.id,
              name: m.name,
              type: m.type,
              tier: m.tier,
              description: m.description,
              preview: m.content.slice(0, 200),
            })),
            count: results.length,
          };
        }

        case "list": {
          const all = manager.list();
          return {
            system: all
              .filter((m: any) => m.tier === "system")
              .map((m: any) => ({
                id: m.id,
                name: m.name,
                type: m.type,
                description: m.description,
              })),
            archive: all
              .filter((m: any) => m.tier === "archive")
              .map((m: any) => ({
                id: m.id,
                name: m.name,
                type: m.type,
                description: m.description,
              })),
            total: all.length,
          };
        }

        case "promote": {
          if (!input.id) return { error: "id required for promote" };
          const ok = manager.promote(input.id);
          if (!ok)
            return {
              error: `Cannot promote "${input.id}" — not found or already in system`,
            };
          return {
            promoted: true,
            id: input.id,
            message: `"${input.id}" moved to system tier (always in prompt)`,
          };
        }

        case "demote": {
          if (!input.id) return { error: "id required for demote" };
          const ok = manager.demote(input.id);
          if (!ok)
            return {
              error: `Cannot demote "${input.id}" — not found or already in archive`,
            };
          return {
            demoted: true,
            id: input.id,
            message: `"${input.id}" moved to archive (search to load)`,
          };
        }

        case "delete": {
          if (!input.id) return { error: "id required for delete" };
          const ok = manager.delete(input.id);
          if (!ok) return { error: `Memory entry "${input.id}" not found` };
          return { deleted: true, id: input.id };
        }

        default:
          return { error: `Unknown operation: ${input.operation}` };
      }
    },
  });
}
