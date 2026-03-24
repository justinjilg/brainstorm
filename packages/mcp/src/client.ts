import type { ToolRegistry } from '@brainstorm/tools';

/**
 * MCP Server configuration — matches .brainstorm/mcp.json format.
 */
export interface MCPServerConfig {
  name: string;
  transport: 'sse' | 'http';
  url: string;
  env?: Record<string, string>;
  enabled?: boolean;
}

/**
 * MCP Client Manager — connects to MCP servers and registers their tools.
 *
 * Uses @ai-sdk/mcp for SSE/HTTP transports. Tools from MCP servers register
 * into the same ToolRegistry as built-in tools.
 */
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

  async connectAll(registry: ToolRegistry): Promise<{ connected: string[]; errors: Array<{ name: string; error: string }> }> {
    const connected: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const server of this.servers) {
      try {
        const { createMCPClient } = await import('@ai-sdk/mcp');
        const client = await createMCPClient({
          transport: {
            type: server.transport,
            url: server.url,
          },
        });

        this.connections.set(server.name, client);

        const tools = await client.tools();
        if (tools) {
          for (const [toolName, toolDef] of Object.entries(tools)) {
            (registry as any).tools.set(`mcp:${server.name}:${toolName}`, {
              name: `mcp:${server.name}:${toolName}`,
              description: (toolDef as any).description ?? toolName,
              permission: 'confirm' as const,
              toAISDKTool: () => toolDef,
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

  async disconnectAll(): Promise<void> {
    for (const [, client] of this.connections) {
      try { await client.close?.(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }

  listConnected(): string[] {
    return Array.from(this.connections.keys());
  }
}
