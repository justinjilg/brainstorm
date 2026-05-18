/**
 * MCP exposure parity gate.
 *
 * Every tool in the local registry must be expressible as an MCP
 * registration via `toMCPTool()`. The Stage-1 metadata gate already
 * checks this for built-in tools; this gate widens the scope to:
 *   - the local God Mode connector registry (when connectors are
 *     wired)
 *   - plugin tools loaded via the plugin SDK (when discoverPlugins
 *     is wired into the registry)
 *
 * Today the broader surfaces aren't yet eagerly loaded at preflight
 * time — God Mode connectors talk to HTTP products and plugin
 * discovery runs at session start. So this gate's runtime scope is
 * currently the built-in registry plus a structural assertion that
 * the `toMCPTool` generator itself is exported.
 *
 * The gate file exists separately from `tool-metadata` so future
 * widening (e.g. validating that every God Mode tool's JSON Schema
 * lowers to an MCP shape) lands in one focused check rather than
 * conflating concerns.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

export async function check({ repoRoot }) {
  const issues = [];

  const distEntry = path.join(repoRoot, "packages/tools/dist/index.js");
  if (!existsSync(distEntry)) {
    return {
      name: "mcp-parity",
      ok: false,
      issues: [
        `@brainst0rm/tools dist missing — run \`npx turbo run build --filter=@brainst0rm/tools\` first.`,
      ],
    };
  }

  const toolsModule = await import(distEntry);
  const { toMCPTool, MCPSchemaUnsupportedError, createDefaultToolRegistry } =
    toolsModule;

  if (typeof toMCPTool !== "function") {
    issues.push(
      "@brainst0rm/tools does not export `toMCPTool`. Stage-1 generator regression.",
    );
  }
  if (typeof MCPSchemaUnsupportedError !== "function") {
    issues.push(
      "@brainst0rm/tools does not export `MCPSchemaUnsupportedError`. The generator's schema-guard error class is missing.",
    );
  }

  if (issues.length > 0) {
    return {
      name: "mcp-parity",
      ok: false,
      issues,
    };
  }

  // Structural: confirm every non-deferred built-in tool produces a
  // valid MCP registration shape. Same loop as tool-metadata.mjs but
  // kept separate so the failure mode reads as "MCP parity broken"
  // rather than "metadata coverage broken" — a tool can have valid
  // metadata and still fail this gate (e.g. inputSchema is a
  // ZodEffects).
  const registry = createDefaultToolRegistry({ daemon: true });
  let checked = 0;
  for (const tool of registry.getAll()) {
    if (tool.deferred) continue;
    try {
      const mcp = toMCPTool(tool);
      if (!mcp.name || !/^[a-z0-9_]+$/.test(mcp.name)) {
        issues.push(
          `${tool.name}: generated MCP name "${mcp.name}" violates the MCP naming pattern (lowercase alphanumeric + underscore).`,
        );
      }
      if (!mcp.description || mcp.description.length === 0) {
        issues.push(`${tool.name}: generated MCP registration has empty description.`);
      }
      if (!mcp.paramShape || typeof mcp.paramShape !== "object") {
        issues.push(`${tool.name}: generated MCP registration has no parameter shape.`);
      }
      checked++;
    } catch (err) {
      issues.push(
        `${tool.name}: toMCPTool threw — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    name: "mcp-parity",
    ok: issues.length === 0,
    issues,
    note: `${checked} eager tools round-trip through toMCPTool`,
  };
}
