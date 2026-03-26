export { defineTool, type BrainstormToolDef } from './base.js';
export { SessionFileTracker, getFileTracker, resetFileTracker } from './file-tracker.js';
export { ToolHealthTracker, getToolHealthTracker, resetToolHealthTracker, type ToolHealthEntry } from './tool-health.js';
export { CheckpointManager, initCheckpointManager, getCheckpointManager } from './checkpoint.js';
export { undoTool } from './builtin/undo.js';
export { scratchpadWriteTool, scratchpadReadTool, getScratchpadEntries, clearScratchpad, formatScratchpadContext } from './builtin/scratchpad.js';
export { askUserTool, resolveAskUser, hasPendingQuestion } from './builtin/ask-user.js';
export { ToolRegistry, type PermissionCheckFn } from './registry.js';
export { fileReadTool } from './builtin/file-read.js';
export { fileWriteTool } from './builtin/file-write.js';
export { fileEditTool } from './builtin/file-edit.js';
export { shellTool } from './builtin/shell.js';
export { globTool } from './builtin/glob.js';
export { grepTool } from './builtin/grep.js';
export { gitStatusTool } from './builtin/git-status.js';
export { gitDiffTool } from './builtin/git-diff.js';
export { gitLogTool } from './builtin/git-log.js';
export { gitCommitTool } from './builtin/git-commit.js';
export { checkGitSafety, formatViolations, hasHardBlock, type GitSafetyViolation } from './builtin/git-safety.js';
export { checkSandbox, type SandboxLevel } from './builtin/sandbox.js';
export { configureSandbox, setBackgroundEventHandler, getBackgroundTasks } from './builtin/shell.js';
export { ghPrTool } from './builtin/gh-pr.js';
export { ghIssueTool } from './builtin/gh-issue.js';
export { gitBranchTool } from './builtin/git-branch.js';
export { gitStashTool } from './builtin/git-stash.js';
export { listDirTool } from './builtin/list-dir.js';
export { multiEditTool } from './builtin/multi-edit.js';
export { batchEditTool } from './builtin/batch-edit.js';
export { webFetchTool } from './builtin/web-fetch.js';
export { webSearchTool } from './builtin/web-search.js';
export { processSpawnTool, processKillTool } from './builtin/process-manage.js';
export { taskCreateTool, taskUpdateTool, taskListTool, setTaskEventHandler, clearTasks } from './builtin/task-manage.js';
export {
  brStatusTool, brBudgetTool, brLeaderboardTool, brInsightsTool,
  brModelsTool, brMemorySearchTool, brMemoryStoreTool, brHealthTool,
} from './builtin/br-intelligence.js';

import { ToolRegistry } from './registry.js';
import { fileReadTool } from './builtin/file-read.js';
import { fileWriteTool } from './builtin/file-write.js';
import { fileEditTool } from './builtin/file-edit.js';
import { shellTool } from './builtin/shell.js';
import { globTool } from './builtin/glob.js';
import { grepTool } from './builtin/grep.js';
import { gitStatusTool } from './builtin/git-status.js';
import { gitDiffTool } from './builtin/git-diff.js';
import { gitLogTool } from './builtin/git-log.js';
import { gitCommitTool } from './builtin/git-commit.js';
import { ghPrTool } from './builtin/gh-pr.js';
import { ghIssueTool } from './builtin/gh-issue.js';
import { gitBranchTool } from './builtin/git-branch.js';
import { gitStashTool } from './builtin/git-stash.js';
import { listDirTool } from './builtin/list-dir.js';
import { multiEditTool } from './builtin/multi-edit.js';
import { batchEditTool } from './builtin/batch-edit.js';
import { webFetchTool } from './builtin/web-fetch.js';
import { webSearchTool } from './builtin/web-search.js';
import { processSpawnTool, processKillTool } from './builtin/process-manage.js';
import { taskCreateTool, taskUpdateTool, taskListTool } from './builtin/task-manage.js';
import { undoTool } from './builtin/undo.js';
import { scratchpadWriteTool, scratchpadReadTool } from './builtin/scratchpad.js';
import { askUserTool } from './builtin/ask-user.js';
import {
  brStatusTool, brBudgetTool, brLeaderboardTool, brInsightsTool,
  brModelsTool, brMemorySearchTool, brMemoryStoreTool, brHealthTool,
} from './builtin/br-intelligence.js';

export function createDefaultToolRegistry(): ToolRegistry {
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
  // Git (6)
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitLogTool);
  registry.register(gitCommitTool);
  registry.register(gitBranchTool);
  registry.register(gitStashTool);
  // GitHub (2)
  registry.register(ghPrTool);
  registry.register(ghIssueTool);
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
  // BrainstormRouter intelligence (8) — native REST calls, no MCP needed
  registry.register(brStatusTool);
  registry.register(brBudgetTool);
  registry.register(brLeaderboardTool);
  registry.register(brInsightsTool);
  registry.register(brModelsTool);
  registry.register(brMemorySearchTool);
  registry.register(brMemoryStoreTool);
  registry.register(brHealthTool);
  return registry;
}
