export {
  runAgentLoop,
  type AgentLoopOptions,
  type CompactionCallbacks,
} from "./agent/loop.js";
export {
  buildSystemPrompt,
  parseAtMentions,
  buildToolAwarenessSection,
} from "./agent/context.js";
export { SessionManager } from "./session/manager.js";
export { PermissionManager } from "./permissions/manager.js";
export {
  compactContext,
  estimateTokenCount,
  needsCompaction,
  getContextPercent,
  enterToolExecution,
  exitToolExecution,
  isToolInFlight,
} from "./session/compaction.js";
export {
  spawnSubagent,
  spawnParallel,
  getSubagentTypeConfig,
  SUBAGENT_TYPE_NAMES,
  type SubagentOptions,
  type SubagentResult,
  type SubagentType,
  type SubagentHookFn,
} from "./agent/subagent.js";
export {
  loadSkills,
  findSkill,
  type SkillDefinition,
} from "./skills/loader.js";
export { MemoryManager, type MemoryEntry } from "./memory/manager.js";
export { DREAM_SYSTEM_PROMPT, buildDreamPrompt } from "./memory/dream.js";
export { getPlanModeTools, getPlanModePrompt } from "./plan/mode.js";
export {
  readMultimodalFile,
  isImageFile,
  isPdfFile,
  requiresVisionModel,
  type MultimodalContent,
} from "./multimodal/reader.js";
export { loadIgnorePatterns, isIgnored } from "./security/ignore.js";
export {
  scanForCredentials,
  redactCredentials,
  type ScanResult,
} from "./security/secret-scanner.js";
export {
  resolveSafe,
  isWithinWorkspace,
  PathTraversalError,
} from "./security/path-guard.js";
export {
  filterResponse,
  createStreamFilter,
  type StreamFilter,
} from "./agent/response-filter.js";
export { normalizeInsightMarkers } from "./agent/insights.js";
export {
  getOutputStylePrompt,
  OUTPUT_STYLES,
  type OutputStyle,
} from "./agent/output-styles.js";
export { createSubagentTool } from "./agent/subagent-tool.js";
export {
  BuildStateTracker,
  type BuildResult,
  type BuildStatus,
} from "./agent/build-state.js";
export { LoopDetector, type LoopWarning } from "./agent/loop-detector.js";
export {
  detectTone,
  toneGuidance,
  type UserTone,
  type ToneResult,
} from "./agent/sentiment.js";
export {
  ReactionTracker,
  type ReactionSignal,
  type ReactionEntry,
} from "./agent/reaction-tracker.js";
export { SessionPatternLearner } from "./learning/session-patterns.js";
export {
  ErrorFixTracker,
  normalizeErrorSignature,
  type ErrorFixPair,
} from "./learning/error-fix-pairs.js";
export {
  createWorktree,
  removeWorktree,
  checkBuild,
  getChangedFiles,
  pickWinner,
  type SpeculativeApproach,
  type SpeculativeResult,
  type SpeculativeOutcome,
} from "./agent/speculative.js";
export {
  buildSelfReviewPrompt,
  parseSelfReviewResponse,
  type SelfReviewResult,
  type SelfReviewOptions,
} from "./agent/self-review.js";
export { FileWatcher, type FileChange } from "./agent/file-watcher.js";
export {
  collectProjectHealth,
  formatProjectHealth,
  type ProjectHealth,
} from "./agent/project-health.js";
export {
  buildRepoMap,
  repoMapToContext,
  type RepoMap,
  type RepoMapEntry,
} from "./agent/repo-map.js";
export {
  semanticSearch,
  indexProject,
  type SearchResult,
} from "./search/semantic.js";
export {
  indexRecentCommits,
  searchCommitHistory,
  formatCommitContext,
  type CommitSummary,
} from "./search/lineage.js";
export { createAuditMiddleware, getAuditLog } from "./audit/logger.js";
export {
  learnStyle,
  formatStyleContext,
  type StyleProfile,
} from "./learning/style-learner.js";
export {
  invokeExternalAgent,
  type ExternalAgentConfig,
  type ExternalAgentResult,
} from "./agent/acp-client.js";
export {
  submitCommunityFix,
  queryCommunityFixes,
  formatCommunityFixes,
  detectFramework,
  type CommunityFixPair,
  type CommunityFixResult,
} from "./learning/community-fixes.js";
export {
  reduceTrajectory,
  formatReductionStats,
  type MessageStatus,
  type ReductionResult,
} from "./session/trajectory-reducer.js";
export {
  TrajectoryRecorder,
  type TrajectoryEvent,
  type TrajectoryEventType,
  type LLMCallData,
  type ToolCallData,
  type ToolResultData,
  type RoutingDecisionData,
} from "./session/trajectory.js";
export {
  predictTaskCost,
  formatCostPrediction,
  type CostPrediction,
  type CostTier,
} from "./agent/cost-predictor.js";
export {
  MiddlewarePipeline,
  createDefaultMiddlewarePipeline,
  isBlocked,
  type AgentMiddleware,
  type MiddlewareState,
  type MiddlewareMessage,
  type MiddlewareToolCall,
  type MiddlewareToolResult,
  type MiddlewareBlock,
} from "./middleware/index.js";
export {
  turnContextMiddleware,
  toolHealthMiddleware,
  buildStateMiddleware,
  loopDetectionMiddleware,
  sentimentMiddleware,
  subagentLimitMiddleware,
  trajectoryReductionMiddleware,
  autoLintMiddleware,
} from "./middleware/index.js";
export {
  SessionCheckpointer,
  type SessionCheckpointData,
} from "./session/session-checkpoint.js";
export {
  shouldUseEnsemble,
  pruneResults,
  selectWinner,
  checkEarlyTermination,
  formatEnsembleResult,
  type EnsembleCandidate,
  type EnsembleResult,
  type EnsembleStrategy,
} from "./agent/ensemble.js";
export {
  classifyActivity,
  summarizeStep,
  formatStepTimeline,
  type ActivityTag,
  type StepSummary,
} from "./agent/step-summary.js";
