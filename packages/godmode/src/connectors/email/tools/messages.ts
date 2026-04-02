/**
 * Email Message Tools — scanning, quarantine, release.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { EmailClient } from "../client.js";
import { createChangeSet, registerExecutor } from "../../../changeset.js";

export function createMessageTools(client: EmailClient): BrainstormToolDef[] {
  registerExecutor("email_bulk_quarantine", async (cs) => {
    const ids = cs.changes.map((c) => c.entity.replace("message:", ""));
    const result = await client.bulkQuarantine(ids);
    if (result.error) return { success: false, message: result.error };
    return {
      success: true,
      message: `${ids.length} messages quarantined`,
      rollbackData: { ids },
    };
  });

  registerExecutor("email_block_sender", async (cs) => {
    const senders = cs.changes.map((c) => c.entity.replace("sender:", ""));
    const result = await client.blockSender(senders);
    if (result.error) return { success: false, message: result.error };
    return { success: true, message: `${senders.length} sender(s) blocked` };
  });

  return [
    defineTool({
      name: "email_dashboard",
      description:
        "Get email security posture: threat counts, verdict breakdown, quarantine status, recent detections.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        client_id: z
          .string()
          .optional()
          .describe("Specific client ID (omit for all)"),
      }),
      async execute({ client_id }) {
        return client.getDashboard(client_id);
      },
    }),

    defineTool({
      name: "email_list_messages",
      description:
        "List analyzed email messages with filtering. Use to find suspicious messages for a user.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        recipient: z.string().optional().describe("Filter by recipient email"),
        sender: z.string().optional().describe("Filter by sender email"),
        verdict: z
          .string()
          .optional()
          .describe("Filter: clean, suspicious, malicious, phishing"),
      }),
      async execute({ recipient, sender, verdict }) {
        const filters: Record<string, string> = {};
        if (recipient) filters.recipient = recipient;
        if (sender) filters.sender = sender;
        if (verdict) filters.verdict = verdict;
        return client.listMessages(filters);
      },
    }),

    defineTool({
      name: "email_message_detail",
      description:
        "Get detailed analysis of a specific email: headers, verdict, threat indicators, agent assessments.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        message_id: z.string().describe("Message ID to inspect"),
      }),
      async execute({ message_id }) {
        return client.getMessageDetail(message_id);
      },
    }),

    defineTool({
      name: "email_quarantine_list",
      description: "List all quarantined messages across all users.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.listQuarantine();
      },
    }),

    defineTool({
      name: "email_quarantine_release",
      description:
        "Release a message from quarantine (deliver to user). Use with caution — only for false positives.",
      permission: "confirm",
      inputSchema: z.object({
        message_id: z.string().describe("Quarantined message ID to release"),
      }),
      async execute({ message_id }) {
        return client.releaseMessage(message_id);
      },
    }),

    defineTool({
      name: "email_bulk_quarantine",
      description:
        "Quarantine multiple messages at once. Returns a ChangeSet for approval.",
      permission: "confirm",
      inputSchema: z.object({
        message_ids: z.array(z.string()).describe("Message IDs to quarantine"),
        reason: z.string().describe("Reason for quarantine"),
      }),
      async execute({ message_ids, reason }) {
        const changes = message_ids.map((id) => ({
          system: "email",
          entity: `message:${id}`,
          operation: "update" as const,
          before: { status: "delivered" },
          after: { status: "quarantined" },
        }));

        const changeset = createChangeSet({
          connector: "email",
          action: "email_bulk_quarantine",
          description: `Quarantine ${message_ids.length} messages: ${reason}`,
          changes,
          simulation: {
            success: true,
            statePreview: { quarantined: message_ids.length },
            cascades: ["Messages will be removed from user inboxes"],
            constraints: [],
            estimatedDuration: "~5 seconds",
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

    defineTool({
      name: "email_block_sender",
      description:
        "Block one or more email senders across all managed mailboxes. Returns a ChangeSet for approval.",
      permission: "confirm",
      inputSchema: z.object({
        senders: z.array(z.string()).describe("Email addresses to block"),
        reason: z.string().describe("Reason for blocking"),
      }),
      async execute({ senders, reason }) {
        const changes = senders.map((s) => ({
          system: "email",
          entity: `sender:${s}`,
          operation: "update" as const,
          before: { status: "allowed" },
          after: { status: "blocked" },
        }));

        const changeset = createChangeSet({
          connector: "email",
          action: "email_block_sender",
          description: `Block ${senders.length} sender(s): ${reason}`,
          changes,
          simulation: {
            success: true,
            statePreview: { blocked: senders },
            cascades: [
              "Future messages from these senders will be auto-quarantined",
            ],
            constraints: [],
            estimatedDuration: "~3 seconds",
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
