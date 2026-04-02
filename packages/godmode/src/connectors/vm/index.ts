/**
 * BrainstormVM Connector — AI-native hypervisor control.
 */

import type { BrainstormToolDef } from "@brainst0rm/tools";
import type {
  GodModeConnector,
  ConnectorConfig,
  ConnectorCapability,
  HealthResult,
} from "../../types.js";
import { VMClient } from "./client.js";
import { createComputeTools } from "./tools/compute.js";

export class VMConnector implements GodModeConnector {
  name = "vm";
  displayName = "BrainstormVM";
  capabilities: ConnectorCapability[] = [
    "compute",
    "storage",
    "network",
    "migration",
    "compliance",
    "audit",
  ];

  private client: VMClient;
  private cachedTools: BrainstormToolDef[] | null = null;

  constructor(config: ConnectorConfig) {
    this.client = new VMClient(config);
  }

  healthCheck(): Promise<HealthResult> {
    return this.client.healthCheck();
  }

  getTools(): BrainstormToolDef[] {
    if (!this.cachedTools) {
      this.cachedTools = [...createComputeTools(this.client)];
    }
    return this.cachedTools;
  }
}

export function createVMConnector(config: ConnectorConfig): VMConnector {
  return new VMConnector(config);
}
