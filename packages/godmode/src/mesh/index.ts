/**
 * Brainstorm A2A Protocol v0.1 — BrainstormRouter mesh-auth Phase 2.
 *
 * Public surface of the mesh-auth implementation. See ./types.ts for wire
 * shapes, ./handler.ts for the broker, ./replay-store.ts for distributed
 * replay protection, ./task-store.ts for async state, and
 * ./trace-context.ts for W3C trace propagation.
 *
 * Plan reference: P2/Wk5 #66 of radiant-petting-kitten rev 2.
 * Spec: brainstorm/docs/a2a-protocol-v01.md (#347, merged).
 */

export * from "./types.js";
export {
  MeshBroker,
  completeTask,
  failTask,
  type CapabilityResolver,
  type Dispatcher,
  type DispatchOutcome,
  type JWTVerifier,
  type MeshBrokerConfig,
  type MeshInvokeInput,
  type MeshInvokeOutcome,
} from "./handler.js";
export {
  InMemorySeenStore,
  RedisSeenStore,
  type MinimalRedisClient,
  type SeenResult,
  type SeenStore,
} from "./replay-store.js";
export {
  InMemoryTaskStore,
  buildAcceptedRecord,
  type TaskStore,
} from "./task-store.js";
export {
  formatTraceparent,
  isSampled,
  newRootTraceparent,
  newSpanId,
  newTraceId,
  nextSpan,
  parseTraceparent,
} from "./trace-context.js";
