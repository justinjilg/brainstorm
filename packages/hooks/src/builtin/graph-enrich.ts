/**
 * Graph Enrichment Hook — enriches search/read tool results with graph context.
 *
 * PreToolUse: when grep/glob/file_read fires, appends graph context
 * (callers, callees, community membership) to help the agent understand
 * the structural role of the code it's about to read.
 *
 * This is a function-type hook — runs in-process with zero shell overhead.
 */

import type { HookDefinition, HookResult } from "../types.js";

interface GraphEnrichOptions {
  /** Function that queries the graph for context. */
  getContext: (query: string) => Promise<string | null>;
}

/**
 * Create graph enrichment hooks.
 * The getContext callback should query the code graph and return
 * a markdown summary of relevant structural context.
 */
export function createGraphEnrichHooks(
  opts: GraphEnrichOptions,
): HookDefinition[] {
  return [
    {
      event: "PreToolUse",
      matcher: "grep|glob|file_read|code_search",
      type: "function",
      command: "graph-enrich",
      description:
        "Enriches search/read with graph context (callers, community)",
      fn: async (context): Promise<HookResult> => {
        // Extract the search query or file path from tool context
        const query =
          (context.query as string) ??
          (context.pattern as string) ??
          (context.path as string) ??
          (context.filePath as string);

        if (!query) {
          return {
            hookId: "graph-enrich",
            event: "PreToolUse",
            success: true,
            durationMs: 0,
          };
        }

        const graphContext = await opts.getContext(query);
        if (graphContext) {
          // Inject graph context as additional output that the agent sees
          return {
            hookId: "graph-enrich",
            event: "PreToolUse",
            success: true,
            output: graphContext,
            durationMs: 0,
          };
        }

        return {
          hookId: "graph-enrich",
          event: "PreToolUse",
          success: true,
          durationMs: 0,
        };
      },
    },
  ];
}
