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
      // Scope trust state by call.id — AI SDK v6 can invoke tool
      // execute() in parallel (default `parallelToolCalls: true`
      // from streamText). A module-level `_activeWindow` pre-fix
      // would be overwritten by the second tool's syncTrustWindow()
      // while the first is awaiting its execute(), corrupting both
      // windows.
      const window = _activeWindows.get(call.id);
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
      // Record the trust level of this tool's output into the
      // call-scoped window.
      const window = _activeWindows.get(result.toolCallId);
      if (window) {
        _activeWindows.set(
          result.toolCallId,
          recordToolTrust(window, result.name),
        );
      }
    },
  };
}

// Per-tool-call active windows keyed by call.id / result.toolCallId.
// Previous implementation used a single module-level variable, which
// broke under parallel tool calls (AI SDK v6 default). sync/flush
// bracket each tool execution in loop.ts and manage entries by id.
const _activeWindows = new Map<string, TrustWindow>();

// Soft cap — if a caller ever forgets to flush, bound memory rather
// than grow unbounded. Each entry is tiny but the invariant matters.
const MAX_ACTIVE_WINDOWS = 1000;

/**
 * Set the active trust window for a specific tool call. Called by
 * loop.ts before runWrapToolCall() for each tool execution.
 */
export function syncTrustWindow(
  metadata: Record<string, unknown>,
  callId: string,
): void {
  if (_activeWindows.size >= MAX_ACTIVE_WINDOWS) {
    // Evict the oldest — this indicates a flush-leak bug upstream,
    // but we'd rather leak one old window than pile up forever.
    const firstKey = _activeWindows.keys().next().value;
    if (firstKey !== undefined) _activeWindows.delete(firstKey);
  }
  _activeWindows.set(
    callId,
    (metadata[TRUST_WINDOW_KEY] as TrustWindow) ?? createTrustWindow(),
  );
}

/**
 * Write the active trust window for a specific tool call back to
 * per-session metadata. Called by loop.ts after runAfterToolResult().
 */
export function flushTrustWindow(
  metadata: Record<string, unknown>,
  callId: string,
): void {
  const window = _activeWindows.get(callId);
  if (window) {
    metadata[TRUST_WINDOW_KEY] = window;
    _activeWindows.delete(callId);
  }
}

/**
 * Clear taint on a specific call's active window (e.g., after human
 * approval). Must be called between sync and flush for the same callId.
 */
export function clearCurrentTaint(callId: string): void {
  if (_activeWindows.has(callId)) {
    _activeWindows.set(callId, clearTaint());
  }
}

/**
 * Read-only accessor for the active trust window. Used by sibling
 * security middleware (notably tool-sequence-detector) that needs
 * the current trust state during wrapToolCall for its OWN decisions
 * — without duplicating the sync/flush bracketing.
 *
 * Returns undefined when the callId has no active window (no sync
 * ran, or flush already happened). Callers should default to
 * "fully trusted" (minTrust=1.0) when undefined, same as the
 * pre-integration behavior.
 */
export function getActiveTrustWindow(callId: string): TrustWindow | undefined {
  return _activeWindows.get(callId);
}
