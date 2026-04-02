/**
 * God Mode — Natural Language Control Plane.
 *
 * Entry point: connectGodMode() takes a ToolRegistry and config,
 * discovers healthy connectors, registers their tools, and returns
 * the dynamic system prompt segment.
 *
 * Usage in CLI:
 *   const gm = await connectGodMode(tools, config.godmode);
 *   systemPromptSegments.push(gm.promptSegment);
 */

export { connectGodMode } from "./connector-registry.js";
export {
  createChangeSet,
  approveChangeSet,
  rejectChangeSet,
  listChangeSets,
  registerExecutor,
} from "./changeset.js";
export { BaseConnector } from "./connector-base.js";
export { createMSPConnector } from "./connectors/msp/index.js";
export { GODMODE_MIGRATION_SQL } from "./audit.js";
export type {
  GodModeConnector,
  GodModeConfig,
  GodModeConnectionResult,
  ConnectorConfig,
  ConnectorCapability,
  ChangeSet,
  ChangeSetStatus,
  Change,
  SimulationResult,
  ActionResult,
  HealthResult,
} from "./types.js";
