/**
 * Email Campaign Detection Tools — cross-tenant phishing campaign hunting.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { EmailClient } from "../client.js";
import { createChangeSet, registerExecutor } from "../../../changeset.js";

export function createCampaignTools(client: EmailClient): BrainstormToolDef[] {
  registerExecutor("email_campaign_respond", async (cs) => {
    const data = cs.simulation.statePreview as any;
    const result = await client.respondToCampaign(data.campaignId, data.action);
    if (result.error) return { success: false, message: result.error };
    return {
      success: true,
      message: `Campaign response executed: ${data.action}`,
    };
  });

  return [
    defineTool({
      name: "email_detect_campaigns",
      description:
        "List detected phishing/spam campaigns across all managed tenants. Shows campaign scope, affected users, and status.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.listCampaigns();
      },
    }),

    defineTool({
      name: "email_campaign_respond",
      description:
        "Take coordinated action against a detected email campaign. Returns a ChangeSet for approval.",
      permission: "confirm",
      inputSchema: z.object({
        campaign_id: z.string().describe("Campaign ID to respond to"),
        action: z
          .enum(["quarantine_all", "block_senders", "notify_users"])
          .describe("Response action to take"),
      }),
      async execute({ campaign_id, action }) {
        const changeset = createChangeSet({
          connector: "email",
          action: "email_campaign_respond",
          description: `Respond to campaign ${campaign_id}: ${action}`,
          changes: [
            {
              system: "email",
              entity: `campaign:${campaign_id}`,
              operation: "execute",
            },
          ],
          simulation: {
            success: true,
            statePreview: { campaignId: campaign_id, action },
            cascades:
              action === "quarantine_all"
                ? [
                    "All campaign messages will be quarantined across all tenants",
                  ]
                : action === "block_senders"
                  ? ["Campaign senders will be blocked across all tenants"]
                  : ["Affected users will receive security notification"],
            constraints: [],
            estimatedDuration:
              action === "notify_users" ? "~30 seconds" : "~10 seconds",
          },
        });

        return {
          changeset_id: changeset.id,
          status: "pending_approval",
          description: changeset.description,
          risk: { score: changeset.riskScore, factors: changeset.riskFactors },
          message: `Call gm_changeset_approve with id "${changeset.id}" after approval.`,
        };
      },
    }),
  ];
}
