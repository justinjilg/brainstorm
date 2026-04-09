/**
 * Trust Propagation Middleware — enforces taint tracking through the agent pipeline.
 *
 * After each tool result, records the trust level of that tool's output.
 * Before each tool call, checks if the current context trust is sufficient
 * for the requested tool. Blocks high-risk tools when context is tainted
 * by untrusted external content.
 *
 * The key defense: an agent that reads a malicious web page cannot
 * immediately use `shell` to exfiltrate data — the context is tainted
 * and shell requires trust >= 0.5.
 */

import type {
  AgentMiddleware,
  MiddlewareToolCall,
  MiddlewareToolResult,
  MiddlewareBlock,
  MiddlewareState,
} from "../types.js";
import {
  createTrustWindow,
  recordToolTrust,
  checkToolTrust,
  clearTaint,
  type TrustWindow,
} from "../../security/trust-labels.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("trust-propagation");

const TRUST_WINDOW_KEY = "_trustWindow";

export function createTrustPropagationMiddleware(): AgentMiddleware {
  return {
    name: "trust-propagation",

    beforeAgent(state: MiddlewareState): MiddlewareState {
      // Initialize trust window if not present — each session gets its own
      if (!state.metadata[TRUST_WINDOW_KEY]) {
        state.metadata[TRUST_WINDOW_KEY] = createTrustWindow();
      }
      return state;
    },

    wrapToolCall(
      call: MiddlewareToolCall,
    ): MiddlewareToolCall | MiddlewareBlock | void {
      // Read trust window from _activeWindow (set by syncTrustWindow per tool call).
      // This is per-session: loop.ts calls syncTrustWindow(sessionMetadata)
      // before each tool execution, scoping trust to the calling session.
      const window = _activeWindow;
      if (!window) return;

      const check = checkToolTrust(window, call.name);
      if (!check.allowed) {
        log.warn(
          {
            tool: call.name,
            reason: check.reason,
            requiredTrust: check.requiredTrust,
            currentTrust: check.currentTrust,
          },
          "Tool call blocked by trust propagation",
        );
        return {
          blocked: true,
          reason: check.reason,
          middleware: "trust-propagation",
        };
      }
    },

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      // Record the trust level of this tool's output into the active window
      if (_activeWindow) {
        _activeWindow = recordToolTrust(_activeWindow, result.name);
      }
    },
  };
}

// Per-tool-call active window. Set by syncTrustWindow() before each tool
// execution and flushed back to per-session metadata by flushTrustWindow().
// This is NOT shared across sessions — each session's metadata holds its own
// TrustWindow, and sync/flush bracket each tool call in loop.ts.
let _activeWindow: TrustWindow | null = null;

/**
 * Set the active trust window from per-session middleware metadata.
 * Called by loop.ts before runWrapToolCall() for each tool execution.
 */
export function syncTrustWindow(metadata: Record<string, unknown>): void {
  _activeWindow =
    (metadata[TRUST_WINDOW_KEY] as TrustWindow) ?? createTrustWindow();
}

/**
 * Write the active trust window back to per-session middleware metadata.
 * Called by loop.ts after runAfterToolResult() for each tool execution.
 */
export function flushTrustWindow(metadata: Record<string, unknown>): void {
  if (_activeWindow) {
    metadata[TRUST_WINDOW_KEY] = _activeWindow;
  }
  _activeWindow = null; // Clear between tool calls to prevent cross-session leakage
}

/**
 * Clear taint on the current window (e.g., after human approves a tool call).
 * Must be called within a sync/flush bracket.
 */
export function clearCurrentTaint(): void {
  if (_activeWindow) {
    _activeWindow = clearTaint();
  }
}
