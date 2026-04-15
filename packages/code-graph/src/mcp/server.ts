/**
 * Code Intelligence MCP Server — exposes 16 structural analysis tools.
 *
 * Runs in-process as part of `brainstorm mcp`. Auto-indexes the project
 * if no graph exists yet.
 */

import { CodeGraph } from "../graph.js";
import { registerCodeIntelTools } from "./tools.js";
import { initializeAdapters } from "../languages/registry.js";
import { executePipeline, createDefaultPipeline } from "../pipeline/index.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("code-intel-mcp");

export interface CodeIntelServerOptions {
  projectPath: string;
  /** Pre-existing graph instance. If not provided, one is created. */
  graph?: CodeGraph;
  /** Skip auto-indexing even if graph is empty. */
  skipAutoIndex?: boolean;
}

/**
 * Register all code intelligence tools on an MCP server.
 *
 * This function accepts any MCP server instance that has a `.tool()` method
 * (duck-typed to avoid hard dependency on @modelcontextprotocol/sdk in code-graph).
 *
 * If the graph is empty and skipAutoIndex is false, runs the full pipeline first.
 */
export async function registerCodeIntelMCP(
  server: {
    tool: (...args: any[]) => void;
    resource?: (...args: any[]) => void;
  },
  options: CodeIntelServerOptions,
): Promise<{ graph: CodeGraph; toolCount: number }> {
  const graph =
    options.graph ?? new CodeGraph({ projectPath: options.projectPath });

  // Auto-index if graph is empty
  const stats = graph.extendedStats();
  if (stats.files === 0 && !options.skipAutoIndex) {
    log.info(
      { projectPath: options.projectPath },
      "Graph is empty — running initial index",
    );

    await initializeAdapters();
    const pipeline = createDefaultPipeline();
    const result = await executePipeline(pipeline, {
      projectPath: options.projectPath,
      graph,
      results: new Map(),
      onProgress: (stage, msg) => log.info({ stage }, msg),
    });

    const finalStats = graph.extendedStats();
    log.info(
      {
        files: finalStats.files,
        nodes: finalStats.nodes,
        edges: finalStats.graphEdges,
        durationMs: result.totalDurationMs,
      },
      "Initial index complete",
    );
  }

  // Register all 16 tools
  registerCodeIntelTools(server as any, graph, options.projectPath);

  // Register graph stats as an MCP resource
  if (server.resource) {
    server.resource("code-intel://stats", "code-intel://stats", async () => {
      const s = graph.extendedStats();
      return {
        contents: [
          {
            uri: "code-intel://stats",
            text: [
              "# Code Intelligence Graph",
              "",
              `- **Files:** ${s.files}`,
              `- **Functions:** ${s.functions}`,
              `- **Classes:** ${s.classes}`,
              `- **Methods:** ${s.methods}`,
              `- **Nodes:** ${s.nodes}`,
              `- **Edges:** ${s.graphEdges}`,
              `- **Communities:** ${s.communities}`,
              `- **Call Edges:** ${s.callEdges}`,
            ].join("\n"),
            mimeType: "text/markdown",
          },
        ],
      };
    });
  }

  return { graph, toolCount: 16 };
}
