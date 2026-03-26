import type { AgentMiddleware, MiddlewareState } from '../types.js';

/** Injects TurnContext summary between turns for agent self-awareness. */
export const turnContextMiddleware: AgentMiddleware = {
  name: 'turn-context',
  beforeAgent(state) {
    // TurnContext injection is handled by the main loop,
    // but this middleware can add additional metadata
    return {
      ...state,
      metadata: {
        ...state.metadata,
        turnContextInjected: true,
      },
    };
  },
};
