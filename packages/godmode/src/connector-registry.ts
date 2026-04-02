/**
 * Connector Registry — auto-discovery and health monitoring.
 *
 * On startup, probes each configured connector's health endpoint.
 * Healthy connectors get their tools registered. Unhealthy ones are skipped
 * with an error message. The system prompt is dynamically built from
 * whatever is healthy.
 */

import type { BrainstormToolDef } from "@brainst0rm/tools";
import type {
  GodModeConnector,
  GodModeConfig,
  GodModeConnectionResult,
} from "./types.js";
import { getChangeSetTools } from "./changeset.js";
import { buildGodModePrompt } from "./prompt.js";

/**
 * Connect all configured God Mode connectors.
 *
 * 1. Probe each connector's health endpoint
 * 2. Register healthy connectors' tools into the ToolRegistry
 * 3. Register ChangeSet tools (always)
 * 4. Build dynamic system prompt from healthy connectors
 * 5. Return connection results
 */
/** Duck-typed registry — accepts anything with a register(tool) method. */
interface ToolRegistryLike {
  register(tool: BrainstormToolDef): void;
}

export async function connectGodMode(
  registry: ToolRegistryLike,
  config: GodModeConfig,
  connectors: GodModeConnector[],
): Promise<GodModeConnectionResult> {
  const connected: GodModeConnectionResult["connectedSystems"] = [];
  const errors: GodModeConnectionResult["errors"] = [];

  // Health check all connectors in parallel
  const results = await Promise.allSettled(
    connectors.map(async (connector) => {
      const health = await connector.healthCheck();
      return { connector, health };
    }),
  );

  // Register healthy connectors' tools
  for (const result of results) {
    if (result.status === "rejected") {
      continue;
    }

    const { connector, health } = result.value;

    if (!health.ok) {
      errors.push({
        name: connector.name,
        error: health.message ?? `Health check failed (${health.latencyMs}ms)`,
      });
      continue;
    }

    // Register all tools from this connector
    const tools = connector.getTools();
    for (const tool of tools) {
      registry.register(tool);
    }

    connected.push({
      name: connector.name,
      displayName: connector.displayName,
      capabilities: connector.capabilities,
      latencyMs: health.latencyMs,
      toolCount: tools.length,
    });
  }

  // Always register ChangeSet tools
  const csTools = getChangeSetTools();
  for (const tool of csTools) {
    registry.register(tool);
  }

  // Build dynamic prompt
  const promptSegment = buildGodModePrompt(connected, config);

  return {
    connectedSystems: connected,
    errors,
    promptSegment,
    totalTools:
      connected.reduce((sum, c) => sum + c.toolCount, 0) + csTools.length,
  };
}
