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

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(shellTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitLogTool);
  registry.register(gitCommitTool);
  return registry;
}
