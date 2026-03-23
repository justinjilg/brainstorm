export { defineTool, type BrainstormToolDef } from './base.js';
export { ToolRegistry } from './registry.js';
export { fileReadTool } from './builtin/file-read.js';
export { fileWriteTool } from './builtin/file-write.js';
export { fileEditTool } from './builtin/file-edit.js';
export { shellTool } from './builtin/shell.js';
export { globTool } from './builtin/glob.js';
export { grepTool } from './builtin/grep.js';

import { ToolRegistry } from './registry.js';
import { fileReadTool } from './builtin/file-read.js';
import { fileWriteTool } from './builtin/file-write.js';
import { fileEditTool } from './builtin/file-edit.js';
import { shellTool } from './builtin/shell.js';
import { globTool } from './builtin/glob.js';
import { grepTool } from './builtin/grep.js';

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(shellTool);
  registry.register(globTool);
  registry.register(grepTool);
  return registry;
}
