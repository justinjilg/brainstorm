/**
 * Quality Signals Middleware — Read:Edit ratio tracking.
 *
 * Inspired by Stella Laurenzo's analysis (anthropics/claude-code#42796):
 * Read:Edit ratio dropped from 6.6 to 2.0 during quality degradation.
 * Good agents read 6x more than they edit. When the ratio drops below 3.0,
 * the model is editing without sufficient research.
 *
 * Tracks per-session tool calls categorized as reads vs writes.
 * Injects a warning into tool results when ratio degrades.
 */

import type {
  AgentMiddleware,
  MiddlewareToolCall,
  MiddlewareToolResult,
} from "../types.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("quality-signals");

const READ_TOOLS = new Set([
  "file_read",
  "glob",
  "grep",
  "list_dir",
  "git_status",
  "git_diff",
  "git_log",
  "git_blame",
  "web_fetch",
  "web_search",
  "memory",
]);

const WRITE_TOOLS = new Set([
  "file_write",
  "file_edit",
  "multi_edit",
  "batch_edit",
  "shell",
]);

const WARN_THRESHOLD = 3.0;

// Sample-size gates so the Read:Edit warning only fires when the ratio is
// statistically meaningful. Fixes Dogfood #1 Bug 3: previously the warning
// fired at 1 read / 3 writes (ratio 0.33) which was a false positive —
// the agent had barely started and its session-end ratio was 10:1.
//
// Raised MIN_WRITES from 3 → 5 and added MIN_TOTAL_CALLS = 10 so the
// warning only fires once the agent has made meaningful progress. In
// Dogfood #1, the first warning at write=3 was false; the second at
// write=6 / total=21 is exactly the threshold this catches.
const MIN_WRITES_BEFORE_WARNING = 5;
const MIN_TOTAL_CALLS_BEFORE_WARNING = 10;

export function createQualitySignalsMiddleware(): AgentMiddleware {
  let readCount = 0;
  let writeCount = 0;
  let warningIssued = false;

  return {
    name: "quality-signals",

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      if (READ_TOOLS.has(result.name)) {
        readCount++;
      } else if (WRITE_TOOLS.has(result.name)) {
        writeCount++;
      }

      // Sample-size gates: need enough writes AND enough total calls for
      // the ratio to be meaningful. Without these, a session with 1 read
      // and 3 writes triggers a false-positive warning on literally the
      // first few tool calls.
      if (writeCount < MIN_WRITES_BEFORE_WARNING) return;
      if (readCount + writeCount < MIN_TOTAL_CALLS_BEFORE_WARNING) return;

      const ratio = writeCount > 0 ? readCount / writeCount : Infinity;

      if (ratio < WARN_THRESHOLD && !warningIssued) {
        warningIssued = true;
        log.warn(
          { readCount, writeCount, ratio: ratio.toFixed(1) },
          "Read:Edit ratio below threshold — agent may be editing without sufficient research",
        );
      }

      // Reset warning flag when ratio recovers
      if (ratio >= WARN_THRESHOLD) {
        warningIssued = false;
      }
    },
  };
}

/** Get current quality metrics for fleet aggregation. */
export interface QualityMetrics {
  readCount: number;
  writeCount: number;
  readEditRatio: number;
}
