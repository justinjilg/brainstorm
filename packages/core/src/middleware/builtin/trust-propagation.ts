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
      // Initialize trust window if not present
      if (!state.metadata[TRUST_WINDOW_KEY]) {
        state.metadata[TRUST_WINDOW_KEY] = createTrustWindow();
      }
      return state;
    },

    wrapToolCall(
      call: MiddlewareToolCall,
    ): MiddlewareToolCall | MiddlewareBlock | void {
      // Access trust window from middleware state via closure
      const window = _currentWindow;
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
      // Record the trust level of this tool's output
      if (_currentWindow) {
        _currentWindow = recordToolTrust(_currentWindow, result.name);
      }
    },
  };
}

// Module-level state for the current trust window.
// KNOWN LIMITATION: shared across all middleware instances in the same process.
// In multi-session deployments, concurrent sessions must call syncTrustWindow/
// flushTrustWindow around each hook invocation to prevent cross-session corruption.
// The middleware pipeline's tool wrapping in loop.ts calls these synchronously
// within each tool execution, which is safe for single-threaded Node.js but
// would need per-session scoping for true concurrent isolation.
let _currentWindow: TrustWindow | null = null;

/**
 * Set the active trust window from middleware state metadata.
 * Called by the middleware pipeline before running hooks.
 */
export function syncTrustWindow(metadata: Record<string, unknown>): void {
  _currentWindow =
    (metadata[TRUST_WINDOW_KEY] as TrustWindow) ?? createTrustWindow();
}

/**
 * Write the trust window back to middleware state metadata.
 * Called by the middleware pipeline after running hooks.
 */
export function flushTrustWindow(metadata: Record<string, unknown>): void {
  if (_currentWindow) {
    metadata[TRUST_WINDOW_KEY] = _currentWindow;
  }
}

/**
 * Clear taint on the current window (e.g., after human approves a tool call).
 */
export function clearCurrentTaint(): void {
  if (_currentWindow) {
    _currentWindow = clearTaint();
  }
}
