import type { AgentMiddleware, MiddlewareState } from '../types.js';

/** Filters unhealthy tools from the available tool set. */
export const toolHealthMiddleware: AgentMiddleware = {
  name: 'tool-health',
  beforeAgent(state) {
    const unhealthy = (state.metadata.unhealthyTools as string[]) ?? [];
    if (unhealthy.length === 0) return;

    return {
      ...state,
      toolNames: state.toolNames.filter((name) => !unhealthy.includes(name)),
    };
  },
};
