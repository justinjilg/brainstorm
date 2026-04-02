/**
 * MSP User Tools — user and access management via BrainstormMSP.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { MSPClient } from "../client.js";
import { createChangeSet, registerExecutor } from "../../../changeset.js";

export function createUserTools(client: MSPClient): BrainstormToolDef[] {
  registerExecutor("msp_disable_user", async (cs) => {
    const userId = cs.changes[0]?.entity.replace("user:", "") ?? "";
    const result = await client.disableUser(userId);
    if (result.error) return { success: false, message: result.error };
    return {
      success: true,
      message: `User ${userId} disabled`,
      rollbackData: { userId, previousStatus: "active" },
    };
  });

  return [
    defineTool({
      name: "msp_user_status",
      description:
        "Get user details: name, role, status, devices, recent activity, access level.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        query: z.string().describe("User name, email, or ID"),
      }),
      async execute({ query }) {
        return client.searchUsers(query);
      },
    }),

    defineTool({
      name: "msp_disable_user",
      description:
        "Disable a user account across all managed systems. Returns a ChangeSet for approval. Use when a user is compromised, offboarded, or needs access revoked.",
      permission: "confirm",
      inputSchema: z.object({
        user_id: z.string().describe("User ID (from msp_user_status)"),
        reason: z
          .string()
          .describe("Reason for disabling (logged in evidence chain)"),
      }),
      async execute({ user_id, reason }) {
        const user = await client.getUser(user_id);
        if (user.error) return { error: user.error };

        const changes = [
          {
            system: "msp",
            entity: `user:${user.email ?? user_id}`,
            operation: "update" as const,
            before: { status: user.status ?? "active" },
            after: { status: "disabled" },
          },
        ];

        const changeset = createChangeSet({
          connector: "msp",
          action: "msp_disable_user",
          description: `Disable user ${user.name ?? user_id}: ${reason}`,
          changes,
          simulation: {
            success: true,
            statePreview: { status: "disabled" },
            cascades: [
              "User will lose access to all managed systems",
              "Active sessions will be terminated",
              "Managed devices will be flagged for review",
            ],
            constraints: [],
            estimatedDuration: "~15 seconds",
          },
        });

        return {
          changeset_id: changeset.id,
          status: "pending_approval",
          description: changeset.description,
          risk: { score: changeset.riskScore, factors: changeset.riskFactors },
          changes: changeset.changes,
          simulation: changeset.simulation,
          message: `ChangeSet created. Call gm_changeset_approve with id "${changeset.id}" after user approval.`,
        };
      },
    }),
  ];
}
