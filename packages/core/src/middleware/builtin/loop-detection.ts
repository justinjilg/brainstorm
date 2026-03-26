import type { AgentMiddleware, MiddlewareToolCall } from '../types.js';

/** Detects repetitive tool call patterns and injects warnings. */
export const loopDetectionMiddleware: AgentMiddleware = {
  name: 'loop-detection',

  // Track consecutive tool calls
  wrapToolCall(call) {
    // Loop detection is handled by LoopDetector in the main loop.
    // This middleware provides a hook point for future enhancements
    // like auto-blocking the 5th consecutive read of the same file.
    return call;
  },
};
