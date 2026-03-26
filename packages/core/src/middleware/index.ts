// Types
export type {
  AgentMiddleware,
  MiddlewareState,
  MiddlewareMessage,
  MiddlewareToolCall,
  MiddlewareToolResult,
  MiddlewareBlock,
} from './types.js';
export { isBlocked } from './types.js';

// Pipeline
export { MiddlewarePipeline } from './pipeline.js';

// Built-in middleware
export { turnContextMiddleware } from './builtin/turn-context.js';
export { toolHealthMiddleware } from './builtin/tool-health.js';
export { buildStateMiddleware } from './builtin/build-state.js';
export { loopDetectionMiddleware } from './builtin/loop-detection.js';
export { sentimentMiddleware } from './builtin/sentiment.js';
export { subagentLimitMiddleware } from './builtin/subagent-limit.js';
export { trajectoryReductionMiddleware } from './builtin/trajectory-reduction.js';
export { autoLintMiddleware } from './builtin/auto-lint.js';

/**
 * Create a default middleware pipeline with all built-in middleware.
 */
import { MiddlewarePipeline } from './pipeline.js';
import { turnContextMiddleware } from './builtin/turn-context.js';
import { toolHealthMiddleware } from './builtin/tool-health.js';
import { buildStateMiddleware } from './builtin/build-state.js';
import { loopDetectionMiddleware } from './builtin/loop-detection.js';
import { sentimentMiddleware } from './builtin/sentiment.js';
import { subagentLimitMiddleware } from './builtin/subagent-limit.js';
import { trajectoryReductionMiddleware } from './builtin/trajectory-reduction.js';
import { autoLintMiddleware } from './builtin/auto-lint.js';

export function createDefaultMiddlewarePipeline(): MiddlewarePipeline {
  const pipeline = new MiddlewarePipeline();
  pipeline.use(turnContextMiddleware);
  pipeline.use(toolHealthMiddleware);
  pipeline.use(buildStateMiddleware);
  pipeline.use(loopDetectionMiddleware);
  pipeline.use(sentimentMiddleware);
  pipeline.use(subagentLimitMiddleware);
  pipeline.use(trajectoryReductionMiddleware);
  pipeline.use(autoLintMiddleware);
  return pipeline;
}
