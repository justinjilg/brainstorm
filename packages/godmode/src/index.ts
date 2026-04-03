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
export { ProductConnector } from "./product-connector.js";
export { createProductConnectors } from "./product-factory.js";
export {
  signEvent,
  verifyEvent,
  createSignedEvent,
  deriveTenantKey,
  canonicalize,
} from "./signing.js";
export {
  verifyJWT,
  extractBearerToken,
  type JWTPayload,
  type AuthResult,
} from "./jwt.js";
export {
  GODMODE_MIGRATION_SQL,
  setAuditPersister,
  getAuditLog,
} from "./audit.js";
export {
  productManifestSchema,
  parseManifest,
  validateManifestData,
  generateManifestTemplate,
  verifyProductContract,
  type ProductManifest,
  type VerifyResult,
} from "./manifest.js";
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
