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
  retryChangeSet,
  listChangeSets,
  registerExecutor,
} from "./changeset.js";
export {
  setChangeSetEventEmitter,
  createTestEmitter,
  type ChangeSetEventEmitter,
  type TestEmitter,
} from "./event-emitter.js";
export { computeBlastRadius } from "./blast-radius.js";
export type { BlastRadius } from "./types.js";
export { ProductConnector } from "./product-connector.js";
export {
  GitHubConnector,
  createGitHubConnector,
  type GitHubConnectorConfig,
} from "./connectors/github/index.js";
export {
  GitHubClient,
  type GitHubClientConfig,
} from "./connectors/github/client.js";
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
  verifyKeycloakJWT,
  extractBearerToken,
  type JWTPayload,
  type KeycloakVerifyOptions,
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

// Stage-2 contract compiler — canonical Zod schemas and generators
// drive the platform-contract verifier and (planned) cross-language
// bindings.
export {
  compileContract,
  CONTRACT_VERSION,
  CONTRACT_BASE_ID,
  type CompilerOutput,
  type CompileOptions,
} from "./contract/compile.js";
export { PLATFORM_ENDPOINTS, type EndpointDef } from "./contract/schemas.js";
export type { EndpointSection } from "./contract/generators/markdown.js";
export type { JsonSchemaBundle } from "./contract/generators/json-schema.js";
export type {
  EndpointCheckPlan,
  ValidationOutcome,
} from "./contract/generators/validator.js";

// A2A Protocol v0.1 — BrainstormRouter mesh-auth + W3C trace context.
// Re-exported so CLI and downstream consumers can import
// `formatTraceparent`, `MeshBroker`, etc. directly from "@brainst0rm/godmode".
export * from "./mesh/index.js";
