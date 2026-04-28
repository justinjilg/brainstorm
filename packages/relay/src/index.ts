// Public surface of @brainst0rm/relay.
//
// The relay is the platform-layer dispatch service per
// docs/endpoint-agent-plan.md (D9): mediates between operators (CLI/SDK)
// and endpoints (brainstorm-agent), per-envelope-signed, audit-chained.
//
// MVP foundation pieces: canonical-form, signing, types. WebSocket server
// + audit log + lifecycle state manager land in subsequent commits.

export * from "./types.js";
export {
  SIGN_CONTEXT,
  type SignContext,
  nfcNormalize,
  canonicalBytes,
  signingInput,
  NfcKeyCollisionError,
} from "./canonical.js";
export {
  SIGNATURE_ALGO,
  type SignatureAlgo,
  type SignableEnvelope,
  digestForSigning,
  signEnvelope,
  verifyEnvelope,
  operatorHmac,
  operatorHmacDispatchRequest,
  constantTimeEqual,
} from "./signing.js";
export {
  type OperatorKeyDerivationInput,
  deriveOperatorHmacKey,
} from "./operator-key.js";
export { AuditLog, type AuditAppendInput } from "./audit.js";
export {
  NonceStore,
  type NonceStoreOptions,
  type NonceCheckResult,
} from "./nonce-store.js";
export {
  SessionStore,
  type TransportHandle,
  type OperatorSession,
  type EndpointSession,
} from "./session-store.js";
export {
  LifecycleManager,
  nextState,
  type LifecycleTransitionInput,
  type LifecycleTransitionResult,
} from "./lifecycle.js";
export {
  DispatchOrchestrator,
  computePreviewHash,
  type DispatchOrchestratorOptions,
  type OperatorDispatchContext,
  type TenantSigningContext,
} from "./dispatch.js";
export {
  ResultRouter,
  type ResultRouterOptions,
  type InflightDispatch,
  type RoutingResult,
} from "./result-router.js";
export {
  AckTimeoutManager,
  type AckTimeoutManagerOptions,
} from "./ack-timeout.js";
export {
  verifyOperatorHmac,
  verifyConnectionProof,
  verifyOperatorAuth,
  type OperatorHmacVerifyResult,
  type ConnectionProofVerifyResult,
  type OperatorAuthVerifyResult,
} from "./verification.js";
export {
  CafVerifier,
  type CafVerifierOptions,
  type CafVerifyResult,
} from "./caf-verifier.js";
export {
  BrOutcomeReporter,
  type BrOutcomeReporterOptions,
  type DispatchOutcomeReport,
  type DispatchOutcome,
} from "./br-outcome-reporter.js";
export { RelayServer, type RelayServerOptions } from "./relay-server.js";
export {
  startWsBinding,
  type WsBindingOptions,
  type WsBindingHandle,
} from "./ws-binding.js";
export {
  EndpointRegistry,
  startEnrollmentHttp,
  type EndpointRegistryOptions,
  type EnrollmentHttpOptions,
  type EnrollmentHttpHandle,
} from "./enrollment.js";
