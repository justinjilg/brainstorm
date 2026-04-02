/**
 * Email Trust Graph Tools — identity relationships and attack path analysis.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { EmailClient } from "../client.js";

export function createTrustTools(client: EmailClient): BrainstormToolDef[] {
  return [
    defineTool({
      name: "email_trust_graph",
      description:
        "Show the trust graph neighborhood for an email address: who they communicate with, relationship strength, anomalies.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        email: z.string().describe("Email address to analyze"),
      }),
      async execute({ email }) {
        return client.getTrustNeighborhood(email);
      },
    }),

    defineTool({
      name: "email_attack_paths",
      description:
        "Analyze potential attack paths from an external sender to internal targets. Shows how a threat could propagate through trust relationships.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        email: z.string().describe("Email address to trace attack paths from"),
      }),
      async execute({ email }) {
        return client.getAttackPaths(email);
      },
    }),
  ];
}
