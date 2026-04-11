export { createTimeoutController } from "./timeout.js";
export { defineTool, type BrainstormToolDef } from "./base.js";
export {
  withWorkspace,
  getWorkspace,
  enterWorkspace,
} from "./workspace-context.js";
export {
  FileReadCache,
  getFileReadCache,
  resetFileReadCache,
} from "./file-cache.js";
export {
  SessionFileTracker,
  getFileTracker,
  resetFileTracker,
} from "./file-tracker.js";
export {
  ToolHealthTracker,
  getToolHealthTracker,
  resetToolHealthTracker,
  type ToolHealthEntry,
} from "./tool-health.js";
export {
  CheckpointManager,
  initCheckpointManager,
  getCheckpointManager,
} from "./checkpoint.js";
export { undoTool } from "./builtin/undo.js";
export {
  scratchpadWriteTool,
  scratchpadReadTool,
  getScratchpadEntries,
  clearScratchpad,
  formatScratchpadContext,
} from "./builtin/scratchpad.js";
export {
  askUserTool,
  resolveAskUser,
  hasPendingQuestion,
} from "./builtin/ask-user.js";
export {
  routingHintTool,
  getRoutingHint,
  consumeRoutingHint,
  resetRoutingHint,
  type RoutingPreference,
} from "./builtin/routing-hint.js";
export { costEstimateTool } from "./builtin/cost-estimate.js";
export { createToolSearchTool } from "./builtin/tool-search.js";
export {
  isParallelSafe,
  classifyToolBatch,
  executeWithParallelism,
  setToolRegistryForParallel,
} from "./parallel.js";
export {
  getTierForComplexity,
  getToolsForTier,
  isToolInTier,
  escalateTier,
  getTierForTool,
  estimateTokenSavings,
  type ToolTier,
} from "./progressive.js";
export {
  DockerSandbox,
  isSafeCommand,
  translatePath,
  type SandboxConfig,
  type SandboxExecResult,
} from "./sandbox/docker-sandbox.js";
export { planPreviewTool } from "./builtin/plan-preview.js";
export {
  beginTransactionTool,
  commitTransactionTool,
  rollbackTransactionTool,
  isTransactionActive,
  recordTransactionFile,
} from "./builtin/transaction.js";
export {
  ToolRegistry,
  ToolRateLimiter,
  getToolRateLimiter,
  type PermissionCheckFn,
} from "./registry.js";
export { fileReadTool } from "./builtin/file-read.js";
export { fileWriteTool } from "./builtin/file-write.js";
export { fileEditTool } from "./builtin/file-edit.js";
export { shellTool } from "./builtin/shell.js";
export { globTool } from "./builtin/glob.js";
export { grepTool } from "./builtin/grep.js";
export { gitStatusTool } from "./builtin/git-status.js";
export { gitDiffTool } from "./builtin/git-diff.js";
export { gitLogTool } from "./builtin/git-log.js";
export { gitCommitTool } from "./builtin/git-commit.js";
export {
  checkGitSafety,
  formatViolations,
  hasHardBlock,
  type GitSafetyViolation,
} from "./builtin/git-safety.js";
export { checkSandbox, type SandboxLevel } from "./builtin/sandbox.js";
export {
  configureSandbox,
  stopDockerSandbox,
  setDockerSandbox,
  setBackgroundEventHandler,
  getBackgroundTasks,
  setToolOutputHandler,
} from "./builtin/shell.js";
export { ghPrTool } from "./builtin/gh-pr.js";
export { ghIssueTool } from "./builtin/gh-issue.js";
export { ghReviewTool } from "./builtin/gh-review.js";
export { ghActionsTool } from "./builtin/gh-actions.js";
export { ghReleaseTool } from "./builtin/gh-release.js";
export { ghSearchTool } from "./builtin/gh-search.js";
export { ghSecurityTool } from "./builtin/gh-security.js";
export { ghRepoTool } from "./builtin/gh-repo.js";
export { gitBranchTool } from "./builtin/git-branch.js";
export { gitStashTool } from "./builtin/git-stash.js";
export { listDirTool } from "./builtin/list-dir.js";
export { multiEditTool } from "./builtin/multi-edit.js";
export { batchEditTool } from "./builtin/batch-edit.js";
export { webFetchTool } from "./builtin/web-fetch.js";
export { webSearchTool } from "./builtin/web-search.js";
export { processSpawnTool, processKillTool } from "./builtin/process-manage.js";
export {
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  setTaskEventHandler,
  clearTasks,
} from "./builtin/task-manage.js";
export {
  brStatusTool,
  brBudgetTool,
  brLeaderboardTool,
  brInsightsTool,
  brModelsTool,
  brMemorySearchTool,
  brMemoryStoreTool,
  brHealthTool,
} from "./builtin/br-intelligence.js";
export {
  createMemoryTools,
  type MemoryBackend,
} from "./builtin/memory-tools.js";
export { daemonSleepTool } from "./builtin/sleep.js";

import { ToolRegistry } from "./registry.js";
import { fileReadTool } from "./builtin/file-read.js";
import { fileWriteTool } from "./builtin/file-write.js";
import { fileEditTool } from "./builtin/file-edit.js";
import { shellTool } from "./builtin/shell.js";
import { globTool } from "./builtin/glob.js";
import { grepTool } from "./builtin/grep.js";
import { gitStatusTool } from "./builtin/git-status.js";
import { gitDiffTool } from "./builtin/git-diff.js";
import { gitLogTool } from "./builtin/git-log.js";
import { gitCommitTool } from "./builtin/git-commit.js";
import { ghPrTool } from "./builtin/gh-pr.js";
import { ghIssueTool } from "./builtin/gh-issue.js";
import { ghReviewTool } from "./builtin/gh-review.js";
import { ghActionsTool } from "./builtin/gh-actions.js";
import { ghReleaseTool } from "./builtin/gh-release.js";
import { ghSearchTool } from "./builtin/gh-search.js";
import { ghSecurityTool } from "./builtin/gh-security.js";
import { ghRepoTool } from "./builtin/gh-repo.js";
import { gitBranchTool } from "./builtin/git-branch.js";
import { gitStashTool } from "./builtin/git-stash.js";
import { listDirTool } from "./builtin/list-dir.js";
import { multiEditTool } from "./builtin/multi-edit.js";
import { batchEditTool } from "./builtin/batch-edit.js";
import { webFetchTool } from "./builtin/web-fetch.js";
import { webSearchTool } from "./builtin/web-search.js";
import { processSpawnTool, processKillTool } from "./builtin/process-manage.js";
import { buildVerifyTool } from "./builtin/build-verify.js";
import {
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
} from "./builtin/task-manage.js";
import { undoTool } from "./builtin/undo.js";
import {
  scratchpadWriteTool,
  scratchpadReadTool,
} from "./builtin/scratchpad.js";
import { askUserTool } from "./builtin/ask-user.js";
import { routingHintTool } from "./builtin/routing-hint.js";
import { costEstimateTool } from "./builtin/cost-estimate.js";
import { planPreviewTool } from "./builtin/plan-preview.js";
import {
  beginTransactionTool,
  commitTransactionTool,
  rollbackTransactionTool,
} from "./builtin/transaction.js";
import {
  brStatusTool,
  brBudgetTool,
  brLeaderboardTool,
  brInsightsTool,
  brModelsTool,
  brMemorySearchTool,
  brMemoryStoreTool,
  brHealthTool,
} from "./builtin/br-intelligence.js";
import { createToolSearchTool } from "./builtin/tool-search.js";
import { daemonSleepTool } from "./builtin/sleep.js";
import { memoryTool } from "./builtin/memory-tool.js";
export { createWiredMemoryTool } from "./builtin/memory-tool.js";
import { pipelineTool } from "./builtin/pipeline-tool.js";
export { createWiredPipelineTool } from "./builtin/pipeline-tool.js";
import {
  codeCallersTool,
  codeCalleesTool,
  codeDefinitionTool,
  codeImpactTool,
  codeStatsTool,
} from "./builtin/code-graph-tools.js";
export { createWiredCodeGraphTools } from "./builtin/code-graph-tools.js";

export function createDefaultToolRegistry(opts?: {
  daemon?: boolean;
}): ToolRegistry {
  const registry = new ToolRegistry();
  // Filesystem (8)
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(multiEditTool);
  registry.register(batchEditTool);
  registry.register(listDirTool);
  registry.register(globTool);
  registry.register(grepTool);
  // Shell (3)
  registry.register(shellTool);
  registry.register(processSpawnTool);
  registry.register(processKillTool);
  registry.register(buildVerifyTool);
  // Git (6)
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitLogTool);
  registry.register(gitCommitTool);
  registry.register(gitBranchTool);
  registry.register(gitStashTool);
  // GitHub (2)
  // GitHub (8)
  registry.register(ghPrTool);
  registry.register(ghIssueTool);
  registry.register(ghReviewTool);
  registry.register(ghActionsTool);
  registry.register(ghReleaseTool);
  registry.register(ghSearchTool);
  registry.register(ghSecurityTool);
  registry.register(ghRepoTool);
  // Web (2)
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  // Tasks (3)
  registry.register(taskCreateTool);
  registry.register(taskUpdateTool);
  registry.register(taskListTool);
  // Undo (1)
  registry.register(undoTool);
  // Scratchpad (2)
  registry.register(scratchpadWriteTool);
  registry.register(scratchpadReadTool);
  // Ask user (1)
  registry.register(askUserTool);
  // Routing + Cost (2)
  registry.register(routingHintTool);
  registry.register(costEstimateTool);
  registry.register(planPreviewTool);
  // Transactions (3)
  registry.register(beginTransactionTool);
  registry.register(commitTransactionTool);
  registry.register(rollbackTransactionTool);
  // BrainstormRouter intelligence (8) — native REST calls, no MCP needed
  registry.register(brStatusTool);
  registry.register(brBudgetTool);
  registry.register(brLeaderboardTool);
  registry.register(brInsightsTool);
  registry.register(brModelsTool);
  registry.register(brMemorySearchTool);
  registry.register(brMemoryStoreTool);
  registry.register(brHealthTool);
  // Memory (1) — read, write, search, promote, demote persistent memory
  registry.register(memoryTool);
  // Code Graph (5) — structural queries via tree-sitter knowledge graph (stubs, wired at runtime)
  registry.register(codeCallersTool);
  registry.register(codeCalleesTool);
  registry.register(codeDefinitionTool);
  registry.register(codeImpactTool);
  registry.register(codeStatsTool);
  // Tool search (1) — discovers and resolves deferred MCP tools
  registry.register(createToolSearchTool(registry));
  // Daemon-only tools — registered when daemon mode is active
  if (opts?.daemon) {
    registry.register(daemonSleepTool);
    registry.register(pipelineTool); // Stub — wired at runtime with createWiredPipelineTool
  }
  return registry;
}
