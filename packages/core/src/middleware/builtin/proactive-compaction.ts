import type { AgentMiddleware, MiddlewareState } from "../types.js";
import { estimateTokenCount } from "../../session/compaction.js";
import type { ConversationMessage } from "../../session/manager.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Three-Tier Proactive Compaction Middleware
 *
 * Implements a graduated response to context pressure, inspired by
 * Claude Code's MicroCompact → AutoCompact → Full Compact pipeline:
 *
 * - Tier 1 (Tool Output Truncation): Handled by tool-output-truncation middleware
 *   Prevents large tool outputs from bloating context in the first place.
 *
 * - Tier 2 (Auto Compact) at 70%: Injects a self-compact instruction that
 *   tells the model to summarize its own recent work. This buys headroom
 *   without a full compaction pass. The model drops internal reasoning
 *   and keeps only the actionable state.
 *
 * - Tier 3 (Full Compact) at 80%: Triggers the hard compaction in
 *   session/compaction.ts — summarizes old turns via LLM and drops them.
 *
 * The 60% hint and 75% warning from the original middleware are preserved
 * as early guidance to prevent reaching the compaction thresholds at all.
 */
export function createProactiveCompactionMiddleware(
  contextWindow = DEFAULT_CONTEXT_WINDOW,
): AgentMiddleware {
  let autoCompactInjected = false;

  return {
    name: "proactive-compaction",

    beforeAgent(state: MiddlewareState): MiddlewareState | void {
      const tokenEstimate = estimateTokenCount(
        state.messages as ConversationMessage[],
      );
      const percent = Math.round((tokenEstimate / contextWindow) * 100);

      // Tier 3 warning at 75% — full compaction is imminent
      if (percent >= 75) {
        return {
          ...state,
          systemPrompt:
            state.systemPrompt +
            "\n\n[CONTEXT WARNING — 75%: Compaction will trigger soon. " +
            "Wrap up the current task. Avoid exploratory tool calls. " +
            "Finish with a concise summary of what you've done and what remains.]",
        };
      }

      // Tier 2 at 70% — inject self-compact instruction (once per session)
      if (percent >= 70 && !autoCompactInjected) {
        autoCompactInjected = true;
        return {
          ...state,
          systemPrompt:
            state.systemPrompt +
            "\n\n[AUTO-COMPACT — 70%: Context is filling up. Before your next response, " +
            "internally summarize your progress so far into a concise state. " +
            "Drop intermediate reasoning and keep only: (1) what task you're working on, " +
            "(2) what files you've modified, (3) what remains to be done, " +
            "(4) any errors or blockers encountered. This helps preserve " +
            "context for the remaining work.]",
        };
      }

      // Early guidance at 60% — stay focused
      if (percent >= 60) {
        return {
          ...state,
          systemPrompt:
            state.systemPrompt +
            "\n\n[CONTEXT NOTE — 60%: Stay focused on the current task. " +
            "Avoid reading large files or making unnecessary tool calls.]",
        };
      }

      // Reset the auto-compact flag once context drops below 60% (after
      // compaction freed headroom) so the tier-2 hint fires again the next
      // time usage climbs back to 70%.
      if (percent < 60 && autoCompactInjected) {
        autoCompactInjected = false;
      }
    },
  };
}
