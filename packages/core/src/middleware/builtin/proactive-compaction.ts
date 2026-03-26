import type { AgentMiddleware, MiddlewareState } from "../types.js";
import { estimateTokenCount } from "../../session/compaction.js";
import type { ConversationMessage } from "../../session/manager.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Proactive compaction middleware.
 *
 * Monitors context usage and injects guidance before hitting the hard 80% threshold:
 * - At 60%: injects a hint to stay focused and avoid unnecessary tool calls
 * - At 75%: injects stronger guidance to self-compact and wrap up
 *
 * This prevents surprise compaction by nudging the model to be efficient
 * as context fills up.
 */
export function createProactiveCompactionMiddleware(
  contextWindow = DEFAULT_CONTEXT_WINDOW,
): AgentMiddleware {
  return {
    name: "proactive-compaction",

    beforeAgent(state: MiddlewareState): MiddlewareState | void {
      const tokenEstimate = estimateTokenCount(
        state.messages as ConversationMessage[],
      );
      const percent = Math.round((tokenEstimate / contextWindow) * 100);

      if (percent >= 75) {
        return {
          ...state,
          systemPrompt:
            state.systemPrompt +
            "\n\n[CONTEXT WARNING: You are using ~75% of available context. " +
            "Wrap up the current task, avoid exploratory tool calls, " +
            "and finish with a concise summary. Compaction will trigger soon.]",
        };
      }

      if (percent >= 60) {
        return {
          ...state,
          systemPrompt:
            state.systemPrompt +
            "\n\n[CONTEXT NOTE: You are using ~60% of available context. " +
            "Stay focused on the current task. Avoid reading large files " +
            "or making unnecessary tool calls.]",
        };
      }
    },
  };
}
