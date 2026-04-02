/**
 * MSP Backup Tools — backup monitoring and management.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { MSPClient } from "../client.js";

export function createBackupTools(client: MSPClient): BrainstormToolDef[] {
  return [
    defineTool({
      name: "msp_backup_coverage",
      description:
        "Get backup coverage summary: how many endpoints are protected, success rate, total capacity, any gaps.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.getBackupCoverage();
      },
    }),

    defineTool({
      name: "msp_backup_status",
      description:
        "Get backup status for a specific device or all devices. Shows last backup time, health, any failures.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        agent_id: z
          .string()
          .optional()
          .describe("Specific agent/device ID (omit for all)"),
      }),
      async execute({ agent_id }) {
        return client.getBackupStatus(agent_id);
      },
    }),

    defineTool({
      name: "msp_retry_backup",
      description:
        "Retry a failed backup job. Non-destructive — just re-triggers the backup.",
      permission: "auto",
      inputSchema: z.object({
        job_id: z.string().describe("Failed backup job ID to retry"),
      }),
      async execute({ job_id }) {
        return client.retryBackup(job_id);
      },
    }),
  ];
}
