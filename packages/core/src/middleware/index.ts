// Types
export type {
  AgentMiddleware,
  MiddlewareState,
  MiddlewareMessage,
  MiddlewareToolCall,
  MiddlewareToolResult,
  MiddlewareBlock,
} from "./types.js";
export { isBlocked } from "./types.js";

// Pipeline
export { MiddlewarePipeline } from "./pipeline.js";

// Built-in middleware
export { turnContextMiddleware } from "./builtin/turn-context.js";
export { toolHealthMiddleware } from "./builtin/tool-health.js";
export { buildStateMiddleware } from "./builtin/build-state.js";
export { loopDetectionMiddleware } from "./builtin/loop-detection.js";
export { sentimentMiddleware } from "./builtin/sentiment.js";
export { subagentLimitMiddleware } from "./builtin/subagent-limit.js";
export { trajectoryReductionMiddleware } from "./builtin/trajectory-reduction.js";
export { autoLintMiddleware } from "./builtin/auto-lint.js";
export { createMemoryExtractionMiddleware } from "./builtin/memory-extract.js";
export { createProactiveCompactionMiddleware } from "./builtin/proactive-compaction.js";
export { createSecurityScanMiddleware } from "./builtin/security-scan.js";
export { createToolOutputTruncationMiddleware } from "./builtin/tool-output-truncation.js";
export {
  createTrustPropagationMiddleware,
  syncTrustWindow,
  flushTrustWindow,
  clearCurrentTaint,
} from "./builtin/trust-propagation.js";
export {
  createToolSequenceDetectorMiddleware,
  setSequenceDetectorTrustRef,
} from "./builtin/tool-sequence-detector.js";
export { createEgressMonitorMiddleware } from "./builtin/egress-monitor.js";
export { createToolContractMiddleware } from "./builtin/tool-contract-enforcement.js";
export { createContentInjectionFilterMiddleware } from "./builtin/content-injection-filter.js";
export {
  createApprovalFrictionMiddleware,
  recordApprovalDecision,
  getApprovalTracker,
} from "./builtin/approval-friction.js";
export { createQualitySignalsMiddleware } from "./builtin/quality-signals.js";
export { createStopDetectionMiddleware } from "./builtin/stop-detection.js";
export {
  createFleetSignalsMiddleware,
  getFleetDashboard,
  pruneFleetState,
} from "./builtin/fleet-signals.js";
export { createConventionMonitorMiddleware } from "./builtin/convention-monitor.js";
export {
  createConventionEnforcementMiddleware,
  BUILTIN_RULES,
  type ConventionRule,
} from "./builtin/convention-enforcement.js";
export {
  createSecretSubstitutionMiddleware,
  setScrubMap,
  consumeScrubMap,
  buildScrubMap,
  injectSecrets,
  scrubSecrets,
  findVaultPatterns,
} from "./builtin/secret-substitution.js";

/**
 * Create a default middleware pipeline with all built-in middleware.
 * @param projectPath - Required for memory extraction middleware.
 */
import { MiddlewarePipeline } from "./pipeline.js";
import { turnContextMiddleware } from "./builtin/turn-context.js";
import { toolHealthMiddleware } from "./builtin/tool-health.js";
import { buildStateMiddleware } from "./builtin/build-state.js";
import { loopDetectionMiddleware } from "./builtin/loop-detection.js";
import { sentimentMiddleware } from "./builtin/sentiment.js";
import { subagentLimitMiddleware } from "./builtin/subagent-limit.js";
import { trajectoryReductionMiddleware } from "./builtin/trajectory-reduction.js";
import { autoLintMiddleware } from "./builtin/auto-lint.js";
import { createMemoryExtractionMiddleware } from "./builtin/memory-extract.js";
import { createProactiveCompactionMiddleware } from "./builtin/proactive-compaction.js";
import { createSecurityScanMiddleware } from "./builtin/security-scan.js";
import { createToolOutputTruncationMiddleware } from "./builtin/tool-output-truncation.js";
import { createTrustPropagationMiddleware } from "./builtin/trust-propagation.js";
import { createToolSequenceDetectorMiddleware } from "./builtin/tool-sequence-detector.js";
import { createEgressMonitorMiddleware } from "./builtin/egress-monitor.js";
import { createToolContractMiddleware } from "./builtin/tool-contract-enforcement.js";
import { createContentInjectionFilterMiddleware } from "./builtin/content-injection-filter.js";
import { createApprovalFrictionMiddleware } from "./builtin/approval-friction.js";
import { codeExtractionMiddleware } from "./code-extraction.js";
import { createQualitySignalsMiddleware } from "./builtin/quality-signals.js";
import { createStopDetectionMiddleware } from "./builtin/stop-detection.js";
import { createFleetSignalsMiddleware } from "./builtin/fleet-signals.js";
import { createConventionMonitorMiddleware } from "./builtin/convention-monitor.js";
import { createSecretSubstitutionMiddleware } from "./builtin/secret-substitution.js";

export function createDefaultMiddlewarePipeline(
  projectPath?: string,
  contextWindow?: number,
): MiddlewarePipeline {
  const pipeline = new MiddlewarePipeline();
  pipeline.use(createTrustPropagationMiddleware()); // Must be first — tracks taint before other middleware
  pipeline.use(createSecretSubstitutionMiddleware()); // Mark $VAULT_* patterns before other middleware sees args
  pipeline.use(createContentInjectionFilterMiddleware()); // Sanitize web content at ingestion
  pipeline.use(createToolContractMiddleware()); // Argument validation — catches dangerous args early
  pipeline.use(createToolSequenceDetectorMiddleware()); // Sequence detection — trust-aware pattern matching
  pipeline.use(createEgressMonitorMiddleware()); // Network boundary — blocks exfiltration patterns
  pipeline.use(createApprovalFrictionMiddleware()); // Human shield — approval velocity + cooling periods
  pipeline.use(turnContextMiddleware);
  pipeline.use(toolHealthMiddleware);
  pipeline.use(buildStateMiddleware);
  pipeline.use(loopDetectionMiddleware);
  pipeline.use(sentimentMiddleware);
  pipeline.use(subagentLimitMiddleware);
  pipeline.use(trajectoryReductionMiddleware);
  pipeline.use(autoLintMiddleware);
  pipeline.use(codeExtractionMiddleware);
  pipeline.use(createToolOutputTruncationMiddleware());
  pipeline.use(createProactiveCompactionMiddleware(contextWindow));
  pipeline.use(createSecurityScanMiddleware());
  // Quality observability (Stella Laurenzo lessons)
  pipeline.use(createQualitySignalsMiddleware()); // Read:Edit ratio tracking
  pipeline.use(createStopDetectionMiddleware()); // Premature stopping detection
  pipeline.use(createFleetSignalsMiddleware()); // Fleet-level aggregation

  if (projectPath) {
    pipeline.use(createMemoryExtractionMiddleware(projectPath));
    pipeline.use(createConventionMonitorMiddleware(projectPath)); // Convention drift
  }
  return pipeline;
}
