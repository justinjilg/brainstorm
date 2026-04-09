export { runOnboardPipeline } from "./pipeline.js";
export { persistOnboardToMemory } from "./memory-bridge.js";
export { runStaticAnalysis } from "./phases/static-analysis.js";
export { runVerification } from "./phases/verification.js";
export { inferBudget, createBudgetTracker } from "./budget.js";
export type {
  OnboardOptions,
  OnboardEvent,
  OnboardContext,
  OnboardResult,
  OnboardPhase,
  OnboardDispatcher,
  ExplorationResult,
  ConventionSet,
  NamingConvention,
  DomainConcept,
  GitWorkflowProfile,
  CICDProfile,
  KeyFileDigest,
  GeneratedAgent,
  GeneratedRoutingRule,
  GeneratedRecipe,
  VerificationResult,
} from "./types.js";
export { ALL_PHASES, PHASE_LABELS } from "./types.js";
