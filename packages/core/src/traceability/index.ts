export {
  generateTraceId,
  generateSequentialTraceId,
  parseTraceId,
  isValidTraceId,
  type ArtifactType,
  type TraceLink,
  type TracedArtifact,
} from "./trace-id.js";

export {
  initTraceabilitySchema,
  saveArtifact,
  loadArtifact,
  listArtifacts,
  traceChain,
  findUntestedRequirements,
  findUntracedChanges,
  getCoverageMetrics,
} from "./store.js";

export {
  validate,
  type ValidationResult,
  type ValidationFinding,
  type ValidationRules,
  type ValidationSeverity,
} from "./validate.js";

export {
  generateAnalyticsReport,
  formatAnalyticsMarkdown,
  type AnalyticsReport,
  type SessionMetrics,
  type ModelMetrics,
  type ToolMetrics,
  type CostMetrics,
  type SectorMetrics,
} from "./analytics.js";

export { registerGovernanceMCPTools } from "./mcp-tools.js";
