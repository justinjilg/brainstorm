export { BrainstormRouter } from "./router.js";
export { classifyTask } from "./classifier.js";
export { CostTracker } from "./cost-tracker.js";
// Individual strategies are used internally by BrainstormRouter.
// Not re-exported — use BrainstormRouter's strategy selection instead.
export {
  learnedStrategy,
  recordOutcome,
  loadStats,
  getTotalSamples,
  getSamplesForTaskType,
  getOutcomeAuditLog,
  getConvergenceAlerts,
  getModelDistribution,
  type OutcomeAuditEntry,
  type ConvergenceAlert,
} from "./strategies/learned.js";
export {
  optimizeTeamComposition,
  type TeamAssignment,
  type TeamComposition,
} from "./team-optimizer.js";
export type { RoutingStrategy } from "./strategies/types.js";
