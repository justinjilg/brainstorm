/**
 * Stop Detection Middleware — catches premature stopping patterns.
 *
 * Inspired by Stella Laurenzo's stop-phrase-guard.sh which caught 173 violations
 * (0 before degradation, 43 on peak day). Detects when the model is trying to
 * stop working prematurely, dodge responsibility, or seek unnecessary permission.
 *
 * Categories (from the report):
 * - Ownership dodging: "not caused by my changes", "existing issue"
 * - Permission-seeking: "should I continue?", "want me to keep going?"
 * - Premature stopping: "good stopping point", "natural checkpoint"
 * - Known-limitation labeling: "known limitation", "future work"
 * - Session-length excuses: "continue in a new session", "getting long"
 *
 * Uses afterModel to scan assistant output. Logs violations as quality signals.
 */

import type { AgentMiddleware, MiddlewareMessage } from "../types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("stop-detection");

interface StopPattern {
  pattern: RegExp;
  category: string;
}

const STOP_PATTERNS: StopPattern[] = [
  // Ownership dodging
  { pattern: /not caused by my changes/i, category: "ownership-dodge" },
  { pattern: /existing issue/i, category: "ownership-dodge" },
  {
    pattern: /pre-existing (?:bug|issue|problem)/i,
    category: "ownership-dodge",
  },
  {
    pattern: /not related to (?:my|the) changes/i,
    category: "ownership-dodge",
  },

  // Permission-seeking
  { pattern: /should I continue/i, category: "permission-seeking" },
  {
    pattern: /want me to (?:keep going|continue|proceed)/i,
    category: "permission-seeking",
  },
  {
    pattern: /shall I (?:go ahead|proceed|continue)/i,
    category: "permission-seeking",
  },
  { pattern: /would you like me to/i, category: "permission-seeking" },
  {
    pattern: /let me know if you (?:want|need|would like)/i,
    category: "permission-seeking",
  },

  // Premature stopping
  { pattern: /good stopping point/i, category: "premature-stop" },
  {
    pattern: /natural (?:checkpoint|break|stopping)/i,
    category: "premature-stop",
  },
  {
    pattern: /I'?ve completed (?:the|all|my) changes/i,
    category: "premature-stop",
  },
  {
    pattern: /the implementation is (?:done|complete|finished)/i,
    category: "premature-stop",
  },

  // Known-limitation labeling
  { pattern: /known limitation/i, category: "limitation-label" },
  { pattern: /future work/i, category: "limitation-label" },
  { pattern: /out of scope/i, category: "limitation-label" },
  { pattern: /beyond the scope/i, category: "limitation-label" },

  // Session-length excuses
  {
    pattern: /continue in a (?:new|fresh) session/i,
    category: "session-excuse",
  },
  {
    pattern: /(?:session|conversation) is getting (?:long|large)/i,
    category: "session-excuse",
  },
  { pattern: /pick this up (?:later|next time)/i, category: "session-excuse" },
];

export function createStopDetectionMiddleware(): AgentMiddleware {
  let violationCount = 0;

  return {
    name: "stop-detection",

    afterModel(message: MiddlewareMessage): MiddlewareMessage | void {
      if (!message.text) return;

      for (const { pattern, category } of STOP_PATTERNS) {
        if (pattern.test(message.text)) {
          violationCount++;
          log.warn(
            {
              category,
              violation: violationCount,
              snippet: message.text.slice(0, 100),
            },
            "Stop phrase detected — potential premature stopping",
          );
          // Don't block — just log. The quality signal is the violation count.
          // A fleet-level aggregator can trigger intervention if violations spike.
          break; // One violation per message is enough signal
        }
      }
    },
  };
}
