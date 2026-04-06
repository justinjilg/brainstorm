/**
 * Edge Agent Connector — brainstorm's interface to brainstorm-agent.
 *
 * Routes through BrainstormMSP's agent management API. The edge agent
 * connects outbound to MSP via WebSocket; this connector uses MSP's
 * REST endpoints to list agents, dispatch commands, read OODA events,
 * inspect evidence chains, and monitor workflows.
 *
 * 12 tools across 3 categories:
 *   Discovery: agent_list, agent_status, agent_ooda_events, agent_ooda_stats,
 *              agent_signals, agent_evidence, agent_verify_evidence, agent_workflows,
 *              agent_workflow_approve
 *   Commands:  agent_run_tool, agent_osquery
 *   Control:   agent_kill_switch
 *
 * All routes verified against BrainstormMSP app/api/edge/core.py.
 */

import type { BrainstormToolDef } from "@brainst0rm/tools";
import type {
  GodModeConnector,
  ConnectorCapability,
  ConnectorConfig,
  HealthResult,
} from "../../types.js";
import { AgentClient } from "./client.js";
import { createAgentTools } from "./tools/agents.js";
import { createCommandTools } from "./tools/commands.js";
import { createControlTools } from "./tools/control.js";
import { buildAgentPrompt } from "./prompt.js";

export class AgentConnector implements GodModeConnector {
  name = "agent";
  displayName = "BrainstormAgent";
  capabilities: ConnectorCapability[] = [
    "endpoint-management",
    "endpoint-security",
    "compliance",
    "audit",
    "evidence",
  ];

  private client: AgentClient;
  private cachedTools: BrainstormToolDef[] | null = null;

  constructor(config: ConnectorConfig) {
    this.client = new AgentClient(config);
  }

  healthCheck(): Promise<HealthResult> {
    return this.client.healthCheck();
  }

  getTools(): BrainstormToolDef[] {
    if (!this.cachedTools) {
      this.cachedTools = [
        ...createAgentTools(this.client),
        ...createCommandTools(this.client),
        ...createControlTools(this.client),
      ];
    }
    return this.cachedTools;
  }

  getPrompt(): string {
    return buildAgentPrompt(0);
  }
}

export function createAgentConnector(config: ConnectorConfig): AgentConnector {
  return new AgentConnector(config);
}
