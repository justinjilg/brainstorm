/**
 * Built-in MCP server definitions — ship with Brainstorm for zero-config setup.
 *
 * These MCP servers are auto-registered when available on the user's system.
 * Each requires its npm package to be installed globally or locally.
 *
 * Flywheel: every MCP tool call is a routing decision + outcome →
 * BR learns which models handle which integrations best.
 */

import type { MCPServerConfig } from "./client.js";

export interface BuiltinMCPServer extends MCPServerConfig {
  /** npm package to check for availability. */
  npmPackage: string;
  /** Description shown in `storm models` and docs. */
  description: string;
}

/**
 * Built-in MCP servers that ship with Brainstorm.
 * Only registered if the required npm package is detected.
 */
export const BUILTIN_MCP_SERVERS: BuiltinMCPServer[] = [
  {
    name: "playwright",
    transport: "stdio",
    command: "npx",
    args: ["@anthropic/mcp-playwright"],
    npmPackage: "@anthropic/mcp-playwright",
    description:
      "Browser automation — navigate, click, fill forms, take screenshots",
    enabled: true,
  },
  {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["@anthropic/mcp-github"],
    npmPackage: "@anthropic/mcp-github",
    description: "GitHub API — issues, PRs, repos, actions, search",
    enabled: true,
  },
  {
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["@anthropic/mcp-filesystem"],
    npmPackage: "@anthropic/mcp-filesystem",
    description: "Advanced filesystem operations beyond built-in tools",
    enabled: true,
  },
];
