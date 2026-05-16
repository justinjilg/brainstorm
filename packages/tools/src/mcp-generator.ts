/**
 * BrainstormToolDef → MCP tool registration shape.
 *
 * Single function every caller uses to expose a built-in tool over MCP.
 * Before this existed, any path that wanted to register a tool with an
 * `McpServer` had to hand-build:
 *   - the MCP tool name (sometimes with dot → underscore conversion)
 *   - the parameter schema (zod shape or JSON Schema)
 *   - the description (possibly prefixed with permission/risk hints)
 *   - the result wrapper (`{ content: [{ type: "text", text: ... }] }`)
 *
 * That's the same drift BR collapsed with `defineCapability()` — five
 * surfaces of the same contract. Funnel every MCP registration through
 * `toMCPTool()` so changes to the shape land in one place.
 *
 * Note: the existing `packages/cli/src/mcp-server.ts` exposes *external*
 * God Mode tools (discovered via HTTP from product servers) and does not
 * use this generator yet — those tools have no local BrainstormToolDef,
 * only a JSON Schema. The generator here is for the local-registry MCP
 * exposure path, used today by the gate test and any future "expose
 * brainstorm's own tools over MCP" wiring.
 */

import type { z } from "zod";
import type { BrainstormToolDef } from "./base.js";
import { resolveToolMetadata } from "./builtin/_metadata.js";

export interface MCPToolRegistration {
  /** MCP tool name (dots replaced with underscores; MCP spec requires this). */
  name: string;
  /** Description shown to MCP clients. Includes protocol notes when present. */
  description: string;
  /** Zod raw shape for the tool's parameters. */
  paramShape: z.ZodRawShape;
  /** Async handler that wraps execute and formats the MCP result envelope. */
  handler: (params: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

/**
 * Convert a BrainstormToolDef into the shape an MCP server can register.
 * The handler wraps `def.execute` and emits the MCP-standard `content`
 * envelope. JSON.stringify is used for the text rendering so structured
 * results survive the round-trip.
 */
export function toMCPTool(def: BrainstormToolDef): MCPToolRegistration {
  const meta = resolveToolMetadata(def.name, {
    category: def.category,
    headlessSafe: def.headlessSafe,
    protocol: def.protocol,
    tags: def.tags,
  });

  // MCP tool names cannot contain dots. Brainstorm's God Mode tools use
  // dot-namespaced names like `msp.endpoint.list`; local tools don't,
  // but the conversion is idempotent for safety.
  const name = def.name.replace(/\./g, "_");

  const description = meta?.protocol
    ? `${def.description}\n\nProtocol: ${meta.protocol}`
    : def.description;

  return {
    name,
    description,
    paramShape: def.inputSchema.shape as z.ZodRawShape,
    handler: async (params) => {
      const result = await def.execute(params);
      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  };
}
