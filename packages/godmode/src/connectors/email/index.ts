/**
 * BrainstormEmailSecurity Connector — communication trust and security.
 */

import type { BrainstormToolDef } from "@brainst0rm/tools";
import type {
  GodModeConnector,
  ConnectorConfig,
  ConnectorCapability,
  HealthResult,
} from "../../types.js";
import { EmailClient } from "./client.js";
import { createMessageTools } from "./tools/messages.js";
import { createTrustTools } from "./tools/trust.js";
import { createCampaignTools } from "./tools/campaigns.js";

export class EmailConnector implements GodModeConnector {
  name = "email";
  displayName = "BrainstormEmailSecurity";
  capabilities: ConnectorCapability[] = [
    "email-security",
    "communication",
    "trust-graph",
    "quarantine",
    "evidence",
  ];

  private client: EmailClient;
  private cachedTools: BrainstormToolDef[] | null = null;

  constructor(config: ConnectorConfig) {
    this.client = new EmailClient(config);
  }

  healthCheck(): Promise<HealthResult> {
    return this.client.healthCheck();
  }

  getTools(): BrainstormToolDef[] {
    if (!this.cachedTools) {
      this.cachedTools = [
        ...createMessageTools(this.client),
        ...createTrustTools(this.client),
        ...createCampaignTools(this.client),
      ];
    }
    return this.cachedTools;
  }
}

export function createEmailConnector(config: ConnectorConfig): EmailConnector {
  return new EmailConnector(config);
}
