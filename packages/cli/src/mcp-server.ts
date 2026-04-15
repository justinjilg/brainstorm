/**
 * Brainstorm MCP Server — exposes God Mode tools via Model Context Protocol.
 *
 * Spawned by Claude Code/Desktop as a subprocess:
 *   { "command": "brainstorm", "args": ["mcp"] }
 *
 * On startup:
 *   1. Resolves API keys from env/1Password
 *   2. Discovers all products via ProductConnector
 *   3. Registers their God Mode tools as MCP tools
 *   4. Serves MCP protocol over stdio
 *
 * Every tool call routes through the God Mode contract:
 *   tool_call → POST /api/v1/god-mode/execute on the product server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface ServerTool {
  name: string;
  domain: string;
  product: string;
  description: string;
  parameters: Record<string, unknown>;
  risk_level: string;
  requires_changeset: boolean;
}

interface ConnectedProduct {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyName: string;
  tools: ServerTool[];
  healthy: boolean;
  latencyMs: number;
}

/**
 * Start the MCP server. Call this from the `brainstorm mcp` command.
 */
export async function startMCPServer(): Promise<void> {
  const server = new McpServer({
    name: "brainstorm",
    version: "0.13.0",
  });

  // ── Discover products and their tools ────────────────────────

  const products = await discoverProducts();
  const allTools: Array<
    ServerTool & { _baseUrl: string; _apiKeyName: string }
  > = [];

  for (const product of products) {
    if (!product.healthy) continue;
    for (const tool of product.tools) {
      allTools.push({
        ...tool,
        _baseUrl: product.baseUrl,
        _apiKeyName: product.apiKeyName,
      });
    }
  }

  // ── Register each tool with MCP ──────────────────────────────

  for (const tool of allTools) {
    // Convert dots to underscores for MCP tool names
    const mcpName = tool.name.replace(/\./g, "_");

    // Build Zod schema from JSONSchema parameters
    const paramProps = (tool.parameters as any)?.properties ?? {};
    const required = new Set((tool.parameters as any)?.required ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, prop] of Object.entries(paramProps)) {
      const p = prop as Record<string, unknown>;
      let field: z.ZodTypeAny;

      if (p.enum && Array.isArray(p.enum)) {
        field = z.enum(p.enum as [string, ...string[]]);
      } else {
        switch (p.type) {
          case "string":
            field = z.string();
            break;
          case "number":
          case "integer":
            field = z.number();
            break;
          case "boolean":
            field = z.boolean();
            break;
          default:
            field = z.any();
        }
      }

      if (p.description) field = field.describe(p.description as string);
      if (!required.has(key)) field = field.optional();
      shape[key] = field;
    }

    server.tool(
      mcpName,
      `[${tool.product}] ${tool.description}`,
      shape,
      async (params) => {
        const result = await executeGodModeTool(
          tool._baseUrl,
          tool._apiKeyName,
          tool.name,
          params,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    );
  }

  // ── Register ecosystem status resource ───────────────────────

  server.resource("brainstorm://status", "brainstorm://status", async () => {
    const lines = [
      "# Brainstorm Ecosystem Status",
      "",
      "## Connected Products",
      ...products.map(
        (p) =>
          `${p.healthy ? "●" : "○"} **${p.displayName}** — ${p.tools.length} tools, ${p.latencyMs}ms${p.healthy ? "" : " (offline)"}`,
      ),
      "",
      `**Total tools:** ${allTools.length}`,
    ];

    return {
      contents: [
        {
          uri: "brainstorm://status",
          text: lines.join("\n"),
          mimeType: "text/markdown",
        },
      ],
    };
  });

  // ── Register Code Intelligence tools ─────────────────────────
  // Adds 16 structural analysis tools (code_query, code_impact, etc.)
  // that expose the code knowledge graph to agents via MCP.

  try {
    const { registerCodeIntelMCP } = await import("@brainst0rm/code-graph");
    const projectPath = process.cwd();
    const { toolCount } = await registerCodeIntelMCP(server as any, {
      projectPath,
      skipAutoIndex: false, // auto-index on first use
    });
    process.stderr.write(
      `[code-intel] Registered ${toolCount} code intelligence tools\n`,
    );
  } catch (err: any) {
    const errorMsg = `Code intelligence tools unavailable: ${err.message}`;
    process.stderr.write(`[code-intel] ${errorMsg}\n`);
    // Register a single diagnostic tool so the user knows WHY tools are missing
    server.tool(
      "code_intel_status",
      `[UNAVAILABLE] ${errorMsg}. Install @brainst0rm/code-graph and rebuild.`,
      {},
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: errorMsg,
              fix: "Run: npm install && npx turbo run build --filter=@brainst0rm/code-graph",
            }),
          },
        ],
      }),
    );
  }

  // ── Register Governance tools ────────────────────────────────
  // Adds 6 governance tools (gov_validate, gov_trace, gov_coverage,
  // gov_artifacts, gov_record, gov_analytics) for enterprise compliance.

  try {
    const { registerGovernanceMCPTools } = await import("@brainst0rm/core");
    const { default: Database } = await import("better-sqlite3");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const dbPath = join(homedir(), ".brainstorm", "brainstorm.db");
    const db = new Database(dbPath);
    const project = process.cwd().split("/").pop() ?? "unknown";
    const toolCount = registerGovernanceMCPTools(server as any, db, project);
    process.stderr.write(
      `[governance] Registered ${toolCount} governance tools\n`,
    );
  } catch (err: any) {
    process.stderr.write(
      `[governance] Governance tools unavailable: ${err.message}\n`,
    );
  }

  // ── Start stdio transport ────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ── Product Discovery ──────────────────────────────────────────

async function discoverProducts(): Promise<ConnectedProduct[]> {
  // Default products + any from config
  const productConfigs: Record<
    string,
    { baseUrl: string; apiKeyName: string }
  > = {
    msp: {
      baseUrl: process.env.BRAINSTORM_MSP_URL ?? "https://brainstormmsp.ai",
      apiKeyName: "BRAINSTORM_MSP_API_KEY",
    },
    br: {
      baseUrl:
        process.env.BRAINSTORM_BR_URL ?? "https://api.brainstormrouter.com",
      apiKeyName: "BRAINSTORM_API_KEY",
    },
    gtm: {
      baseUrl: process.env.BRAINSTORM_GTM_URL ?? "https://catsfeet.com",
      apiKeyName: "BRAINSTORM_GTM_API_KEY",
    },
    vm: {
      baseUrl: process.env.BRAINSTORM_VM_URL ?? "https://vm.brainstorm.co",
      apiKeyName: "BRAINSTORM_VM_API_KEY",
    },
    shield: {
      baseUrl:
        process.env.BRAINSTORM_SHIELD_URL ?? "https://shield.brainstorm.co",
      apiKeyName: "BRAINSTORM_SHIELD_API_KEY",
    },
  };

  const products: ConnectedProduct[] = [];

  await Promise.allSettled(
    Object.entries(productConfigs).map(async ([id, cfg]) => {
      const apiKey = process.env[cfg.apiKeyName];
      if (!apiKey) {
        products.push({
          id,
          displayName: id.toUpperCase(),
          baseUrl: cfg.baseUrl,
          apiKeyName: cfg.apiKeyName,
          tools: [],
          healthy: false,
          latencyMs: 0,
        });
        return;
      }

      const start = Date.now();
      try {
        // Health check
        const healthRes = await fetch(`${cfg.baseUrl}/health`, {
          signal: AbortSignal.timeout(10_000),
        });
        const health = (await healthRes.json()) as any;
        const latencyMs = Date.now() - start;

        // Fetch tools
        const toolsRes = await fetch(`${cfg.baseUrl}/api/v1/god-mode/tools`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        });

        let tools: ServerTool[] = [];
        if (toolsRes.ok) {
          const data = (await toolsRes.json()) as any;
          tools = data.tools ?? [];
        }

        products.push({
          id,
          displayName: health.product
            ? `Brainstorm${health.product.charAt(0).toUpperCase() + health.product.slice(1)}`
            : id.toUpperCase(),
          baseUrl: cfg.baseUrl,
          apiKeyName: cfg.apiKeyName,
          tools,
          healthy: health.status === "healthy" || health.status === "ok",
          latencyMs,
        });
      } catch {
        products.push({
          id,
          displayName: id.toUpperCase(),
          baseUrl: cfg.baseUrl,
          apiKeyName: cfg.apiKeyName,
          tools: [],
          healthy: false,
          latencyMs: Date.now() - start,
        });
      }
    }),
  );

  return products;
}

// ── God Mode Tool Execution ────────────────────────────────────

async function executeGodModeTool(
  baseUrl: string,
  apiKeyName: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const apiKey = process.env[apiKeyName];
  if (!apiKey) {
    return { error: `No API key: ${apiKeyName}` };
  }

  try {
    const res = await fetch(`${baseUrl}/api/v1/god-mode/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tool: toolName, params }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: `${res.status}: ${body.slice(0, 200)}` };
    }

    const data = (await res.json()) as any;
    return data.data ?? data;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
