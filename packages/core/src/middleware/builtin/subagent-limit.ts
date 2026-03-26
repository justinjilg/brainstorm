import type { AgentMiddleware, MiddlewareMessage } from '../types.js';

/**
 * Hardware-enforces maximum concurrent subagent spawns.
 * Inspired by DeerFlow's SubagentLimitMiddleware:
 * "prompt-based limits are less reliable than hardware enforcement."
 */
export const subagentLimitMiddleware: AgentMiddleware = {
  name: 'subagent-limit',

  afterModel(message) {
    const MAX_CONCURRENT = 3;

    // Count subagent tool calls in the response
    const subagentCalls = message.toolCalls.filter(
      (tc) => tc.name === 'spawn_subagent' || tc.name === 'spawn_parallel',
    );

    if (subagentCalls.length <= MAX_CONCURRENT) return;

    // Truncate to max (keep first N, drop rest)
    const kept = new Set(subagentCalls.slice(0, MAX_CONCURRENT).map((tc) => tc.id));
    return {
      ...message,
      toolCalls: message.toolCalls.filter(
        (tc) => !subagentCalls.includes(tc) || kept.has(tc.id),
      ),
    };
  },
};
