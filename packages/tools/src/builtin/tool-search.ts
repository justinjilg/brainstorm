import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRegistry } from "../registry.js";

/**
 * Create the tool_search tool — discovers and resolves deferred MCP tools.
 *
 * MCP tool schemas are loaded lazily: only names + descriptions at startup.
 * When the model needs an MCP tool, it calls tool_search to find matching
 * tools by keyword. Matched tools are resolved (deferred flag cleared),
 * making their full schemas available in subsequent turns.
 */
export function createToolSearchTool(registry: ToolRegistry) {
  return defineTool({
    name: "tool_search",
    description:
      "Search for available MCP tools by keyword. Returns matching tool names and descriptions. " +
      "Matched tools become available for use in subsequent turns. Use this when you need a " +
      "specialized tool that isn't in your current tool set (e.g., database, API, or service tools).",
    permission: "auto",
    concurrent: true,
    readonly: true,
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Keywords to search for in tool names and descriptions. " +
            'Use "select:name1,name2" to resolve specific tools by exact name.',
        ),
      max_results: z
        .number()
        .optional()
        .default(5)
        .describe("Maximum number of results to return (default: 5)."),
    }),
    execute: async (input: { query: string; max_results?: number }) => {
      const deferred = registry.listDeferred();
      if (deferred.length === 0) {
        return {
          ok: true,
          message: "No deferred tools available. All tools are already loaded.",
          tools: [],
        };
      }

      const maxResults = input.max_results ?? 5;
      let matched: Array<{ name: string; description: string }>;

      // Direct selection: "select:tool1,tool2"
      if (input.query.startsWith("select:")) {
        const names = input.query
          .slice(7)
          .split(",")
          .map((n) => n.trim());
        // Exact name match only — substring matching would over-enable privileged tools
        matched = deferred.filter((t) => names.some((n) => t.name === n));
      } else {
        // Keyword search across name + description
        const terms = input.query.toLowerCase().split(/\s+/);
        const scored = deferred.map((t) => {
          const text = `${t.name} ${t.description}`.toLowerCase();
          let score = 0;
          for (const term of terms) {
            if (text.includes(term)) score++;
          }
          return { ...t, score };
        });
        matched = scored
          .filter((t) => t.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);
      }

      // Resolve matched tools — clears deferred flag so they appear in next turn
      const resolved: string[] = [];
      for (const tool of matched) {
        if (registry.resolveDeferred(tool.name)) {
          resolved.push(tool.name);
        }
      }

      return {
        ok: true,
        message:
          resolved.length > 0
            ? `Resolved ${resolved.length} tool(s). They are now available for use.`
            : "No matching tools found.",
        tools: matched.map((t) => ({
          name: t.name,
          description: t.description,
        })),
        resolved,
        totalDeferred: deferred.length,
      };
    },
  });
}
