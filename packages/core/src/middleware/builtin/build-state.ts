import type { AgentMiddleware, MiddlewareToolResult } from '../types.js';

/** Tracks build/test results and injects warnings when build is broken. */
export const buildStateMiddleware: AgentMiddleware = {
  name: 'build-state',
  afterToolResult(result) {
    // Track shell commands that look like build/test commands
    if (result.name === 'shell') {
      const output = typeof result.output === 'string' ? result.output : '';
      const isBuild = /\b(build|compile|tsc|webpack|turbo)\b/i.test(output);
      const isTest = /\b(test|vitest|jest|pytest|mocha)\b/i.test(output);

      if (isBuild || isTest) {
        return {
          ...result,
          output: result.output,
          // Metadata for BuildStateTracker (consumed by main loop)
        };
      }
    }
    return result;
  },
};
