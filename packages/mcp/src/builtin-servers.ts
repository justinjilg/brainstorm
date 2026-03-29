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
  {
    name: "slack",
    transport: "stdio",
    command: "npx",
    args: ["@anthropic/mcp-slack"],
    npmPackage: "@anthropic/mcp-slack",
    description:
      "Slack API — send messages, read channels, search history, manage threads",
    enabled: true,
  },
  {
    name: "linear",
    transport: "stdio",
    command: "npx",
    args: ["mcp-linear"],
    npmPackage: "mcp-linear",
    description:
      "Linear API — create/update issues, manage projects, track cycles and milestones",
    enabled: true,
  },
  {
    name: "jira",
    transport: "stdio",
    command: "npx",
    args: ["mcp-jira"],
    npmPackage: "mcp-jira",
    description:
      "Jira API — create/update issues, manage sprints, query boards and backlogs",
    enabled: true,
  },
  {
    name: "notion",
    transport: "stdio",
    command: "npx",
    args: ["@anthropic/mcp-notion"],
    npmPackage: "@anthropic/mcp-notion",
    description:
      "Notion API — read/write pages, databases, search workspace content",
    enabled: true,
  },
  {
    name: "datadog",
    transport: "stdio",
    command: "npx",
    args: ["mcp-datadog"],
    npmPackage: "mcp-datadog",
    description:
      "Datadog API — query metrics, monitors, logs, APM traces, dashboards",
    enabled: true,
  },
  {
    name: "aws",
    transport: "stdio",
    command: "npx",
    args: ["mcp-aws"],
    npmPackage: "mcp-aws",
    description: "AWS API — S3, Lambda, CloudWatch, DynamoDB, IAM operations",
    enabled: true,
  },
  {
    name: "stripe",
    transport: "stdio",
    command: "npx",
    args: ["@anthropic/mcp-stripe"],
    npmPackage: "@anthropic/mcp-stripe",
    description:
      "Stripe API — customers, subscriptions, payments, invoices, webhooks",
    enabled: true,
  },
];
