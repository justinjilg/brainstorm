/**
 * Product Factory — creates generic ProductConnectors from config.
 *
 * Replaces the hardcoded factory map { msp: createMSPConnector, ... }.
 * Adding a new product = adding a [godmode.connectors.X] config entry.
 */

import { ProductConnector } from "./product-connector.js";
import type { GodModeConnector, GodModeConfig } from "./types.js";

/**
 * Create and initialize ProductConnectors for all enabled connectors in config.
 * Each connector fetches its tool definitions from the product server.
 * Initialization failures are non-fatal — the connector will have 0 tools.
 */
export async function createProductConnectors(
  config: GodModeConfig,
): Promise<GodModeConnector[]> {
  const connectors: GodModeConnector[] = [];

  const entries = Object.entries(config.connectors ?? {});
  if (entries.length === 0) return connectors;

  // Initialize all connectors in parallel for faster boot
  const results = await Promise.allSettled(
    entries
      .filter(([, cfg]) => cfg.enabled !== false)
      .map(async ([id, cfg]) => {
        const connector = new ProductConnector(id, cfg as any);
        await connector.initialize();
        return connector;
      }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      connectors.push(result.value);
    }
    // Rejected connectors are already logged by ProductConnector.initialize()
  }

  return connectors;
}
