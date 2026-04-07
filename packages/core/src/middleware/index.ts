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
import { codeExtractionMiddleware } from "./code-extraction.js";

export function createDefaultMiddlewarePipeline(
  projectPath?: string,
  contextWindow?: number,
): MiddlewarePipeline {
  const pipeline = new MiddlewarePipeline();
  pipeline.use(createTrustPropagationMiddleware()); // Must be first — tracks taint before other middleware
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
  if (projectPath) {
    pipeline.use(createMemoryExtractionMiddleware(projectPath));
  }
  return pipeline;
}
