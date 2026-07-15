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
      const entry = _activeWindows.get(call.id);
      if (!entry) return;
      const window = entry.window;

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
      const entry = _activeWindows.get(result.toolCallId);
      if (entry) {
        _activeWindows.set(result.toolCallId, {
          window: recordToolTrust(entry.window, result.name),
          createdAt: entry.createdAt,
        });
      }
    },
  };
}

// Per-tool-call active windows keyed by call.id / result.toolCallId.
// Previous implementation used a single module-level variable, which
// broke under parallel tool calls (AI SDK v6 default). sync/flush
// bracket each tool execution in loop.ts and manage entries by id.
// Each entry carries a createdAt so the soft-cap sweep can evict by AGE
// rather than by insertion order — evicting a still-in-flight call's
// window would SKIP its trust check (a security bypass), so we only ever
// evict entries older than the TTL.
const _activeWindows = new Map<
  string,
  { window: TrustWindow; createdAt: number }
>();

// Soft cap — if a caller ever forgets to flush, prefer bounding memory.
// But we only evict STALE entries (see WINDOW_TTL_MS); if every entry is
// fresh we exceed the cap and warn rather than evict a live window.
const MAX_ACTIVE_WINDOWS = 1000;

// A tool call genuinely in flight for >10 min is already dead by upstream
// timeout, so its window is safe to evict. Mirrors SCRUB_MAP_TTL_MS in
// secret-substitution.ts.
const WINDOW_TTL_MS = 10 * 60 * 1000;

/**
 * Set the active trust window for a specific tool call. Called by
 * loop.ts before runWrapToolCall() for each tool execution.
 */
export function syncTrustWindow(
  metadata: Record<string, unknown>,
  callId: string,
): void {
  if (_activeWindows.size >= MAX_ACTIVE_WINDOWS) {
    // Evict STALE entries only. Map iteration is insertion order == age
    // order, so sweep from the front deleting entries past the TTL and
    // stop at the first fresh one. Evicting a still-in-flight window
    // would skip its trust check (a fail-open security bypass), so if
    // nothing is stale we do NOT evict — insert anyway, exceed the soft
    // cap, and warn (a visible slow leak beats a silent trust bypass).
    const cutoff = Date.now() - WINDOW_TTL_MS;
    let evicted = 0;
    for (const [id, entry] of _activeWindows) {
      if (entry.createdAt >= cutoff) break;
      _activeWindows.delete(id);
      evicted++;
    }
    if (evicted === 0) {
      log.warn(
        { size: _activeWindows.size, cap: MAX_ACTIVE_WINDOWS },
        "Active trust windows exceeded soft cap with no stale entries — possible flush leak; exceeding cap to preserve in-flight trust checks",
      );
    }
  }
  _activeWindows.set(callId, {
    window: (metadata[TRUST_WINDOW_KEY] as TrustWindow) ?? createTrustWindow(),
    createdAt: Date.now(),
  });
}

/**
 * Write the active trust window for a specific tool call back to
 * per-session metadata. Called by loop.ts after runAfterToolResult().
 */
export function flushTrustWindow(
  metadata: Record<string, unknown>,
  callId: string,
): void {
  const entry = _activeWindows.get(callId);
  if (entry) {
    metadata[TRUST_WINDOW_KEY] = entry.window;
    _activeWindows.delete(callId);
  } else {
    // Missing window is evidence of eviction or a sync/flush imbalance —
    // the session's taint state won't be updated. Surface it.
    log.warn(
      { callId },
      "flushTrustWindow: no active window for callId (evicted or never synced)",
    );
  }
}

/**
 * Clear taint on a specific call's active window (e.g., after human
 * approval). Must be called between sync and flush for the same callId.
 */
export function clearCurrentTaint(callId: string): void {
  const entry = _activeWindows.get(callId);
  if (entry) {
    _activeWindows.set(callId, {
      window: clearTaint(),
      createdAt: entry.createdAt,
    });
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
  return _activeWindows.get(callId)?.window;
}
