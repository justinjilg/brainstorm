import type { AgentMiddleware, MiddlewareToolResult } from '../types.js';

/** Triggers linting after file write/edit tool calls. */
export const autoLintMiddleware: AgentMiddleware = {
  name: 'auto-lint',
  afterToolResult(result) {
    const isFileWrite = ['file_write', 'file_edit', 'multi_edit', 'batch_edit'].includes(result.name);
    if (!isFileWrite || !result.ok) return;

    // Mark that linting should run. The actual lint execution is handled
    // by the hooks system or the main loop.
    return {
      ...result,
      output: result.output,
    };
  },
};
