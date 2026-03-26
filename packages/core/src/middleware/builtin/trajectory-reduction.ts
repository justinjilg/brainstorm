import type { AgentMiddleware, MiddlewareState } from '../types.js';

/**
 * Runs trajectory reduction after tool results to prune expired/redundant context.
 * Integrates with the TrajectoryReducer from session/trajectory-reducer.ts.
 */
export const trajectoryReductionMiddleware: AgentMiddleware = {
  name: 'trajectory-reduction',
  beforeAgent(state) {
    // Trajectory reduction runs in beforeAgent to clean up context
    // before the next LLM call. The actual reduction logic is in
    // session/trajectory-reducer.ts — this middleware marks the state
    // so the main loop knows to run reduction.
    return {
      ...state,
      metadata: {
        ...state.metadata,
        shouldReduceTrajectory: true,
      },
    };
  },
};
