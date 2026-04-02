/**
 * BrainstormMSP Connector — endpoint management, backup, discovery, users.
 *
 * The first God Mode connector. Proves the pattern that all
 * subsequent connectors (Email, VM, GTM, Ops) follow.
 */

import type { BrainstormToolDef } from "@brainst0rm/tools";
import type {
  GodModeConnector,
  ConnectorConfig,
  ConnectorCapability,
  HealthResult,
} from "../../types.js";
import { MSPClient } from "./client.js";
import { createDeviceTools } from "./tools/devices.js";
import { createUserTools } from "./tools/users.js";
import { createBackupTools } from "./tools/backup.js";
import { createDiscoveryTools } from "./tools/discovery.js";

export class MSPConnector implements GodModeConnector {
  name = "msp";
  displayName = "BrainstormMSP";
  capabilities: ConnectorCapability[] = [
    "endpoint-management",
    "endpoint-security",
    "backup",
    "service-discovery",
    "user-management",
    "access-control",
    "evidence",
  ];

  private client: MSPClient;
  private cachedTools: BrainstormToolDef[] | null = null;

  constructor(config: ConnectorConfig) {
    this.client = new MSPClient(config);
  }

  healthCheck(): Promise<HealthResult> {
    return this.client.healthCheck();
  }

  getTools(): BrainstormToolDef[] {
    if (!this.cachedTools) {
      this.cachedTools = [
        ...createDeviceTools(this.client),
        ...createUserTools(this.client),
        ...createBackupTools(this.client),
        ...createDiscoveryTools(this.client),
      ];
    }
    return this.cachedTools;
  }
}

/**
 * Factory function for creating the MSP connector from config.
 */
export function createMSPConnector(config: ConnectorConfig): MSPConnector {
  return new MSPConnector(config);
}
