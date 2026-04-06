/**
 * Agent Control Tools — kill switch.
 *
 * Kill switch is a critical operation that goes through ChangeSets.
 * Route verified: POST /api/v1/edge/agents/:id/kill in MSP core.py.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { AgentClient } from "../client.js";
import { createChangeSet, registerExecutor } from "../../../changeset.js";

export function createControlTools(client: AgentClient): BrainstormToolDef[] {
  registerExecutor("agent_kill_switch", async (cs) => {
    const meta = cs.simulation.statePreview as any;
    const result = await client.killSwitch(meta.agentId, meta.reason);
    if (result.error) return { success: false, message: result.error };
    return {
      success: true,
      message: `Kill switch activated on ${result.hostname ?? meta.agentId}`,
    };
  });

  return [
    defineTool({
      name: "agent_kill_switch",
      description:
        "Activate the kill switch on an edge agent. Immediately disables all autonomous operations and puts the agent into degraded/read-only mode. " +
        "Use only for emergencies — compromised endpoint, runaway automation, or security incident. Returns a ChangeSet for approval.",
      permission: "confirm",
      inputSchema: z.object({
        agent_id: z.string().describe("Target agent ID"),
        reason: z
          .string()
          .describe(
            "Reason for kill switch activation (logged in evidence chain)",
          ),
      }),
      async execute({ agent_id, reason }) {
        const changeset = createChangeSet({
          connector: "agent",
          action: "agent_kill_switch",
          description: `KILL SWITCH on agent ${agent_id}: ${reason}`,
          changes: [
            {
              system: "agent",
              entity: `agent:${agent_id}`,
              operation: "update",
              before: { autonomy: "enabled" },
              after: { autonomy: "killed", reason },
            },
          ],
          simulation: {
            success: true,
            statePreview: { agentId: agent_id, reason },
            cascades: [
              "All autonomous operations will stop immediately",
              "Agent enters degraded/read-only mode",
              "Pending workflows will not execute",
              "Manual intervention required to resume",
            ],
            constraints: [],
            estimatedDuration: "< 2 seconds",
          },
        });

        return {
          changeset_id: changeset.id,
          status: "pending_approval",
          description: changeset.description,
          risk: { score: changeset.riskScore, factors: changeset.riskFactors },
          message: `KILL SWITCH ChangeSet created. Call gm_changeset_approve with id "${changeset.id}" to activate.`,
        };
      },
    }),
  ];
}
