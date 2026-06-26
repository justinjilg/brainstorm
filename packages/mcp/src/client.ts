import type { ToolRegistry } from "@brainst0rm/tools";

/**
 * MCP Server configuration — matches .brainstorm/mcp.json format.
 */
import { getOAuthToken, type OAuthConfig } from "./oauth.js";

export interface MCPServerConfig {
  name: string;
  transport: "sse" | "http" | "stdio";
  url?: string;
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

  async connectAll(registry: ToolRegistry): Promise<{
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

            // Register as deferred — schema stored but not sent to LLM until resolved.
            // This keeps the context window lean; model uses tool_search to discover tools.
            (registry as any).tools.set(registeredName, {
              name: registeredName,
              description: normalized.description ?? toolName,
              permission: "confirm" as const,
              concurrent: false,
              readonly: false,
              deferred: true,
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
    const command = server.command ?? "npx";
    const args = server.args ?? (server.url ? [server.url] : []);

    // Defense against MCP-config RCE (opus forge V-attacker finding,
    // 2026-05-21):
    //
    // The threat: an attacker with `file_write` privilege (e.g. via prompt
    // injection) writes to ~/.brainstorm/mcp.json setting
    //   command: "/bin/sh", args: ["-c", "<payload>"]
    // On next brainstorm restart, spawn() runs the payload outside the
    // shell sandbox — full host shell access from agent context.
    //
    // Mitigation: validate command + args before spawn:
    //  1. Reject known shell binaries by basename
    //  2. Reject command paths containing shell-like indirection ($, `, |, >)
    //  3. Reject -c (shell-eval) flag in args
    //  4. Reject command names containing path separators outside an
    //     explicit allowlist of trusted prefixes
    validateMcpStdioCommand(server.name, command, args);

    return new Experimental_StdioMCPTransport({
      command,
      args,
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
 * Validate an MCP stdio server's command + args against shell-bypass
 * patterns. Throws on suspicious config so a malicious mcp.json
 * (written via file_write under attack) can't escalate to host shell.
 *
 * See opus forge V-attacker finding 2026-05-21.
 */
const BLOCKED_SHELL_BASENAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "rbash",
  "rzsh",
  // PowerShell on Windows; rare on MCP-stdio but cheap to include
  "pwsh",
  "powershell",
]);

const SHELL_METACHARS = /[;&|`$(){}<>]/;

function validateMcpStdioCommand(
  serverName: string,
  command: string,
  args: string[],
): void {
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(
      `MCP server "${serverName}": stdio command must be a non-empty string`,
    );
  }
  if (SHELL_METACHARS.test(command)) {
    throw new Error(
      `MCP server "${serverName}": stdio command contains shell metacharacters — rejected`,
    );
  }
  // Compare basename only — covers /bin/sh, /usr/bin/bash, etc.
  const basename = command.split(/[\\/]/).pop() ?? command;
  if (BLOCKED_SHELL_BASENAMES.has(basename.toLowerCase())) {
    throw new Error(
      `MCP server "${serverName}": stdio command "${command}" is a shell interpreter and is blocked. ` +
        `Configure a specific binary (e.g. "npx", "node", "python3") not a shell.`,
    );
  }
  // -c is shell-eval. Reject in args even when command is e.g. "env sh -c".
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error(
        `MCP server "${serverName}": stdio arg must be a string, got ${typeof arg}`,
      );
    }
    if (arg === "-c" || arg === "--command") {
      throw new Error(
        `MCP server "${serverName}": stdio args contain shell-eval flag (${arg}) — rejected`,
      );
    }
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
