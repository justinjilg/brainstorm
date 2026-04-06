/**
 * Agent Command Tools — dispatch commands to edge agents via MSP relay.
 *
 * Commands hit POST /api/v1/edge/agents/:id/command on MSP. MSP determines
 * risk level from its own tool registry (get_tool_risk_level), creates a
 * remediation workflow, and dispatches via WebSocket as a signed
 * CommandEnvelope. High-risk commands require approval in MSP before
 * the agent executes them.
 *
 * All routes verified against BrainstormMSP app/api/edge/core.py.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { AgentClient } from "../client.js";

export function createCommandTools(client: AgentClient): BrainstormToolDef[] {
  return [
    defineTool({
      name: "agent_run_tool",
      description:
        "Execute a tool on a remote edge agent via MSP command dispatch. MSP determines risk level and approval requirements. " +
        "Read-only tools execute immediately. Medium/high/critical risk tools require approval in MSP's workflow system. " +
        "The agent has 30+ tools — use agent_status to see available tools on a specific agent.\n\n" +
        "Common tools: system.info, process.list, service.list, service.control, " +
        "file.read, file.hash, osquery.query, discovery.hardware, discovery.software, " +
        "discovery.network, network.connections, patch.apply, script.execute",
      permission: "confirm",
      inputSchema: z.object({
        agent_id: z.string().describe("Target agent ID (UUID from agent_list)"),
        tool: z
          .string()
          .describe(
            "Tool name on the agent (e.g. system.info, process.list, osquery.query)",
          ),
        params: z
          .record(z.any())
          .default({})
          .describe("Tool parameters as key-value pairs"),
        reason: z
          .string()
          .optional()
          .describe("Reason for execution (logged in audit trail)"),
      }),
      async execute({ agent_id, tool, params, reason }) {
        const result = await client.sendCommand(agent_id, {
          tool,
          params,
          reason,
        });
        if ("error" in result) return { error: result.error };
        return result;
      },
    }),

    defineTool({
      name: "agent_osquery",
      description:
        "Run an osquery SQL query on a remote edge agent. The agent has osquery integrated with 300+ virtual tables for deep endpoint visibility. " +
        "Examples: 'SELECT * FROM processes WHERE name LIKE \"%chrome%\"', 'SELECT * FROM users', 'SELECT * FROM listening_ports'.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        agent_id: z.string().describe("Target agent ID"),
        query: z.string().describe("osquery SQL query"),
      }),
      async execute({ agent_id, query }) {
        const result = await client.sendCommand(agent_id, {
          tool: "osquery.query",
          params: { query },
          reason: "osquery from brainstorm",
        });
        if ("error" in result) return { error: result.error };
        return result;
      },
    }),
  ];
}
