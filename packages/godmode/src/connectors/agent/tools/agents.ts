/**
 * Agent Discovery & Status Tools — list, inspect, and monitor edge agents.
 *
 * All routes verified against BrainstormMSP app/api/edge/core.py.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { AgentClient } from "../client.js";

export function createAgentTools(client: AgentClient): BrainstormToolDef[] {
  return [
    defineTool({
      name: "agent_list",
      description:
        "List all enrolled edge agents with status, hostname, OS, version, OODA cycle state, and pending actions. Filter by status (online/offline/degraded), client, or hostname.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        status: z
          .enum(["online", "offline", "degraded"])
          .optional()
          .describe("Filter by agent status"),
        client_id: z.string().optional().describe("Filter by client/org ID"),
        name: z.string().optional().describe("Filter by hostname"),
      }),
      async execute(params) {
        return client.listAgents(params);
      },
    }),

    defineTool({
      name: "agent_status",
      description:
        "Get detailed status of a specific edge agent including trust score.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        agent_id: z.string().describe("Agent ID (UUID from agent_list)"),
      }),
      async execute({ agent_id }) {
        const [agent, trust] = await Promise.all([
          client.getAgent(agent_id),
          client.getAgentTrustScore(agent_id),
        ]);
        if (agent.error) return { error: agent.error };
        return { agent, trust_score: trust.error ? null : trust };
      },
    }),

    defineTool({
      name: "agent_ooda_events",
      description:
        "Get OODA loop events (anomalies, decisions, executions, narratives) from edge agents. " +
        "Filter by agent, event type, risk level, or severity. Shows the agent's autonomous reasoning and actions.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        agent_id: z
          .string()
          .optional()
          .describe("Filter to a specific agent ID"),
        event_type: z
          .enum(["anomaly", "decision", "execution", "narrative"])
          .optional()
          .describe("Filter by OODA event type"),
        risk_level: z.string().optional().describe("Filter by risk level"),
        severity: z.string().optional().describe("Filter by severity"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe("Number of events to return"),
      }),
      async execute(params) {
        return client.getOODAEvents(params);
      },
    }),

    defineTool({
      name: "agent_ooda_stats",
      description:
        "Get 24-hour OODA event statistics across all agents — anomaly counts, decision breakdown, execution success rates.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.getOODAStats();
      },
    }),

    defineTool({
      name: "agent_signals",
      description:
        "List active signals (alerts, anomalies) from edge agents that may need attention or triage.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.listSignals();
      },
    }),

    defineTool({
      name: "agent_evidence",
      description:
        "List evidence chain entries from edge agent operations. Each entry has before/after state with cryptographic hashes.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.listEvidence();
      },
    }),

    defineTool({
      name: "agent_verify_evidence",
      description:
        "Verify the cryptographic evidence chain for edge agent operations. Checks hash continuity and signature validity.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.verifyEvidenceChain();
      },
    }),

    defineTool({
      name: "agent_workflows",
      description:
        "List active and recent remediation workflows dispatched to edge agents. Shows OODA cycle state, approval status, and outcomes.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.listWorkflows();
      },
    }),
  ];
}
