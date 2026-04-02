/**
 * MSP Discovery Tools — asset discovery and inventory.
 */

import { z } from "zod";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import type { MSPClient } from "../client.js";

export function createDiscoveryTools(client: MSPClient): BrainstormToolDef[] {
  return [
    defineTool({
      name: "msp_discover_assets",
      description:
        "Discover and list assets across the managed environment. Supports filtering by type, class, status, client.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({
        asset_type: z
          .string()
          .optional()
          .describe("Filter: endpoint, server, network, cloud"),
        status: z
          .string()
          .optional()
          .describe("Filter: active, inactive, needs_review"),
        search: z
          .string()
          .optional()
          .describe("Free-text search across all asset fields"),
      }),
      async execute({ asset_type, status, search }) {
        const filters: Record<string, string> = {};
        if (asset_type) filters.asset_type = asset_type;
        if (status) filters.status = status;
        if (search) filters.search = search;
        return client.discoverAssets(filters);
      },
    }),

    defineTool({
      name: "msp_discovery_stats",
      description:
        "Get discovery statistics: total assets, types breakdown, merge state, health overview.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        return client.getDiscoveryStats();
      },
    }),
  ];
}
