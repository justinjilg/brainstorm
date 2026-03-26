import type { ToolRegistry } from "@brainstorm/tools";

/**
 * MCP Server configuration — matches .brainstorm/mcp.json format.
 */
import { getOAuthToken, type OAuthConfig } from "./oauth.js";

export interface MCPServerConfig {
  name: string;
  transport: "sse" | "http" | "stdio";
  url: string;
  /** For stdio transport: command to spawn. */
  command?: string;
  /** For stdio transport: arguments to pass. */
  args?: string[];
  /** Environment variables passed to the server process. */
  env?: Record<string, string>;
  enabled?: boolean;
  /** Optional tool name filter — only register tools matching these names. */
  toolFilter?: string[];
  /** OAuth client_credentials authentication. */
  auth?: OAuthConfig;
}

/**
 * MCP Client Manager — connects to MCP servers and registers their tools.
 *
 * Uses @ai-sdk/mcp for SSE/HTTP transports. Tools from MCP servers register
 * into the same ToolRegistry as built-in tools.
 */
/**
 * Normalize MCP tool definitions for LLM provider compatibility.
 * Anthropic requires input_schema.type = "object" — some MCP tools omit it.
 */
function normalizeMCPTool(toolDef: any): any {
  if (!toolDef || typeof toolDef !== "object") return toolDef;

  // Deep clone to avoid mutating the original
  const normalized = { ...toolDef };

  // If the tool has a parameters/inputSchema, ensure it has type: "object"
  if (normalized.parameters && typeof normalized.parameters === "object") {
    if (!normalized.parameters.type) {
      normalized.parameters = { type: "object", ...normalized.parameters };
    }
    if (!normalized.parameters.properties) {
      normalized.parameters.properties = {};
    }
  }

  return normalized;
}

export class MCPClientManager {
  private servers: MCPServerConfig[] = [];
  private connections: Map<string, any> = new Map();

  addServers(configs: MCPServerConfig[]): void {
    for (const config of configs) {
      if (config.enabled !== false) {
        this.servers.push(config);
      }
    }
  }

  async connectAll(
    registry: ToolRegistry,
  ): Promise<{
    connected: string[];
    errors: Array<{ name: string; error: string }>;
  }> {
    const connected: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const server of this.servers) {
      try {
        const { createMCPClient } = await import("@ai-sdk/mcp");

        // Resolve auth headers (OAuth token or static API key)
        let authHeaders: Record<string, string> = {};
        if (server.auth?.type === "oauth") {
          const token = await getOAuthToken(server.auth);
          authHeaders = { Authorization: `Bearer ${token}` };
        } else if (server.env?.BRAINSTORM_API_KEY) {
          authHeaders = {
            Authorization: `Bearer ${server.env.BRAINSTORM_API_KEY}`,
          };
        }

        const transport =
          server.transport === "stdio"
            ? await this.createStdioTransport(server)
            : {
                type: server.transport as "sse" | "http",
                url: server.url,
                ...(Object.keys(authHeaders).length > 0
                  ? { headers: authHeaders }
                  : {}),
              };

        const client = await createMCPClient({ transport });

        this.connections.set(server.name, client);

        const tools = await client.tools();
        if (tools) {
          const filterSet = server.toolFilter
            ? new Set(server.toolFilter)
            : null;
          for (const [toolName, toolDef] of Object.entries(tools)) {
            if (filterSet && !filterSet.has(toolName)) continue;

            // Validate MCP tool definition before registering
            if (!validateMCPTool(toolName, toolDef)) {
              errors.push({
                name: server.name,
                error: `Malformed tool "${toolName}" — skipped`,
              });
              continue;
            }

            // Use underscores instead of colons — LLM providers reject colons in tool names
            const registeredName = `mcp_${server.name}_${toolName}`;

            // Normalize MCP tool schema for LLM provider compatibility:
            // Anthropic requires input_schema.type = "object", some MCP tools omit it
            const normalized = normalizeMCPTool(toolDef as any);

            (registry as any).tools.set(registeredName, {
              name: registeredName,
              description: normalized.description ?? toolName,
              permission: "confirm" as const,
              toAISDKTool: () => normalized,
            });
          }
        }

        connected.push(server.name);
      } catch (err: any) {
        errors.push({ name: server.name, error: err.message });
      }
    }

    return { connected, errors };
  }

  private async createStdioTransport(server: MCPServerConfig): Promise<any> {
    const { Experimental_StdioMCPTransport } =
      await import("@ai-sdk/mcp/mcp-stdio");
    return new Experimental_StdioMCPTransport({
      command: server.command ?? "npx",
      args: server.args ?? [server.url],
      env: { ...process.env, ...server.env } as Record<string, string>,
    });
  }

  async disconnectAll(): Promise<void> {
    for (const [, client] of this.connections) {
      try {
        await client.close?.();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
  }

  listConnected(): string[] {
    return Array.from(this.connections.keys());
  }
}

/**
 * Validate an MCP tool definition has required fields.
 * Rejects malformed tools to prevent injection or runtime errors.
 */
function validateMCPTool(name: string, toolDef: any): boolean {
  if (!toolDef || typeof toolDef !== "object") return false;
  if (typeof name !== "string" || name.length === 0) return false;
  // Must have a description (string)
  if (toolDef.description && typeof toolDef.description !== "string")
    return false;
  // If inputSchema/parameters exist, must be an object
  const schema = toolDef.parameters ?? toolDef.inputSchema;
  if (schema && typeof schema !== "object") return false;
  return true;
}
