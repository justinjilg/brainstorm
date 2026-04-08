/**
 * Approval Friction Middleware — risk-proportional resistance to tool execution.
 *
 * Integrates the approval velocity tracker into the middleware pipeline.
 * When the human is rubber-stamping (rapid approvals), injects friction:
 *
 *   - Cooling period warning injected into the tool result output
 *   - High-risk tools during cooling require the human to wait
 *   - Approval stats tracked per session for dashboard display
 *
 * This middleware doesn't directly block (that's the permission manager's job).
 * Instead, it instruments tool results with velocity metadata so the TUI
 * can enforce the cooling period at the prompt level.
 */

import type {
  AgentMiddleware,
  MiddlewareState,
  MiddlewareToolCall,
  MiddlewareToolResult,
  MiddlewareBlock,
} from "../types.js";
import {
  ApprovalVelocityTracker,
  type VelocityWarning,
} from "../../security/approval-velocity.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("approval-friction");

const APPROVAL_TRACKER_KEY = "_approvalVelocity";
const LAST_WARNING_KEY = "_approvalWarning";

/** High-risk tools that require extra friction during cooling periods. */
const HIGH_RISK_TOOLS = new Set([
  "shell",
  "process_spawn",
  "git_push",
  "agent_run_tool",
  "agent_kill_switch",
  "agent_workflow_approve",
]);

export function createApprovalFrictionMiddleware(): AgentMiddleware {
  const tracker = new ApprovalVelocityTracker();

  return {
    name: "approval-friction",

    beforeAgent(state: MiddlewareState): MiddlewareState {
      // Expose tracker in metadata for TUI access
      state.metadata[APPROVAL_TRACKER_KEY] = tracker;
      return state;
    },

    wrapToolCall(
      call: MiddlewareToolCall,
    ): MiddlewareToolCall | MiddlewareBlock | void {
      // During cooling period, block high-risk tools entirely
      if (tracker.shouldDelay() && HIGH_RISK_TOOLS.has(call.name)) {
        const remaining = tracker.getCoolingRemaining();
        log.info(
          { tool: call.name, coolingMs: remaining },
          "High-risk tool blocked during approval cooling period",
        );
        return {
          blocked: true,
          reason: `Approval cooling period active (${Math.ceil(remaining / 1000)}s remaining). Too many rapid approvals detected — please review carefully before continuing. High-risk tool "${call.name}" requires the cooling period to expire.`,
          middleware: "approval-friction",
        };
      }
    },

    afterToolResult(result: MiddlewareToolResult): MiddlewareToolResult | void {
      // If we have a pending velocity warning, attach it to the next result
      const lastWarning = _pendingWarning;
      if (lastWarning) {
        _pendingWarning = null;
        return {
          ...result,
          output: {
            ...(typeof result.output === "object" && result.output !== null
              ? result.output
              : { content: String(result.output) }),
            _approval_warning: lastWarning.message,
            _cooling_ms: lastWarning.coolingMs,
            _rapid_count: lastWarning.rapidCount,
          },
        };
      }
    },
  };
}

// Module-level pending warning state.
// KNOWN LIMITATION: shared across all middleware instances in the same process.
// In multi-session deployments, one session's warning could be consumed by another.
// Fix requires threading state through the middleware pipeline's metadata dict.
let _pendingWarning: VelocityWarning | null = null;

/**
 * Record an approval decision from the TUI.
 * Called by the permission prompt handler after the human responds.
 * Returns a warning if approval velocity is too high.
 */
export function recordApprovalDecision(
  tracker: ApprovalVelocityTracker,
  toolName: string,
  decision: "approve" | "deny",
  decisionTimeMs: number,
): VelocityWarning | null {
  const warning = tracker.recordApproval(toolName, decision, decisionTimeMs);
  if (warning) {
    _pendingWarning = warning;
  }
  return warning;
}

/**
 * Get the approval velocity tracker from middleware state metadata.
 */
export function getApprovalTracker(
  metadata: Record<string, unknown>,
): ApprovalVelocityTracker | null {
  return (metadata[APPROVAL_TRACKER_KEY] as ApprovalVelocityTracker) ?? null;
}
