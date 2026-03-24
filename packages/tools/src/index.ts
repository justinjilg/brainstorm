export { defineTool, type BrainstormToolDef } from './base.js';
export { CheckpointManager } from './checkpoint.js';
export { ToolRegistry } from './registry.js';
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
export { listDirTool } from './builtin/list-dir.js';
export { multiEditTool } from './builtin/multi-edit.js';
export { webFetchTool } from './builtin/web-fetch.js';
export { webSearchTool } from './builtin/web-search.js';
export { processSpawnTool, processKillTool } from './builtin/process-manage.js';
export { taskCreateTool, taskUpdateTool, taskListTool, setTaskEventHandler, clearTasks } from './builtin/task-manage.js';

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
import { listDirTool } from './builtin/list-dir.js';
import { multiEditTool } from './builtin/multi-edit.js';
import { webFetchTool } from './builtin/web-fetch.js';
import { webSearchTool } from './builtin/web-search.js';
import { processSpawnTool, processKillTool } from './builtin/process-manage.js';
import { taskCreateTool, taskUpdateTool, taskListTool } from './builtin/task-manage.js';

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Filesystem (7)
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(multiEditTool);
  registry.register(listDirTool);
  registry.register(globTool);
  registry.register(grepTool);
  // Shell (3)
  registry.register(shellTool);
  registry.register(processSpawnTool);
  registry.register(processKillTool);
  // Git (4)
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitLogTool);
  registry.register(gitCommitTool);
  // Web (2)
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  // Tasks (3)
  registry.register(taskCreateTool);
  registry.register(taskUpdateTool);
  registry.register(taskListTool);
  return registry;
}
