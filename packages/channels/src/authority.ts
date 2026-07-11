/**
 * Channel authority → permission mapping.
 *
 * A channel's {@link ChannelAuthority} determines what the agent loop is
 * allowed to do when driven from that channel. The MVP ships **read-only**
 * end-to-end: the "approvals" and "full" enum values exist, but approvals'
 * ChangeSet flow lands in a later stage. Until then "approvals" behaves like
 * "read-only" at the permission gate — mutating tools are blocked — while the
 * {@link BlockedCallCollector} captures what the model *tried* to do so the
 * approvals stage can later surface those as proposed ChangeSets.
 */

import type { AgentEvent, ToolPermission } from "@brainst0rm/shared";
import type { ChannelAuthority } from "./types.js";

/** Matches the shape of `@brainst0rm/tools` PermissionCheckFn. */
export type PermissionCheck = (
  toolName: string,
  toolPermission: ToolPermission,
) => "allow" | "confirm" | "deny";

/**
 * Build the permission-check function for a channel authority level.
 *
 * - `read-only` / `approvals`: only permission `"auto"` tools run (repo
 *   convention: `"auto"` == read-only, mirroring PermissionManager plan mode).
 *   Everything else is denied — never "confirm", because a chat channel has no
 *   synchronous approval UI in the MVP.
 * - `full`: everything runs except tools explicitly marked `"deny"`.
 */
export function buildAuthorityCheck(
  authority: ChannelAuthority,
): PermissionCheck {
  return (_toolName, toolPermission) => {
    if (authority === "full") {
      return toolPermission === "deny" ? "deny" : "allow";
    }
    // read-only AND approvals: read-only tools only.
    return toolPermission === "auto" ? "allow" : "deny";
  };
}

/**
 * Consumes {@link AgentEvent}s from a run and records the tool calls that were
 * blocked by the permission gate (i.e. the mutating tools the model wanted to
 * use but couldn't under a read-only/approvals authority). The approvals stage
 * consumes {@link blocked} to turn these into proposed ChangeSets.
 */
export class BlockedCallCollector {
  /** Calls seen via tool-call-start but not yet resolved, in arrival order. */
  private pending: Array<{ tool: string; input: unknown }> = [];
  private blockedCalls: Array<{ tool: string; input: unknown }> = [];

  /** Feed a single agent event. */
  consume(event: AgentEvent): void {
    if (event.type === "tool-call-start") {
      this.pending.push({ tool: event.toolName, input: event.args });
      return;
    }
    if (event.type === "tool-call-result") {
      const entry = this.take(event.toolName);
      if (entry && isPermissionBlocked(event.result)) {
        this.blockedCalls.push(entry);
      }
    }
  }

  /** Tool calls that the permission gate refused. */
  blocked(): Array<{ tool: string; input: unknown }> {
    return [...this.blockedCalls];
  }

  /**
   * Remove and return the earliest pending call matching `tool`. AgentEvents
   * carry no callId, so we match by name in FIFO order — correct for the common
   * case and never over-reports (a non-matching result just finds nothing).
   */
  private take(tool: string): { tool: string; input: unknown } | null {
    const idx = this.pending.findIndex((p) => p.tool === tool);
    if (idx === -1) return null;
    return this.pending.splice(idx, 1)[0];
  }
}

/**
 * Detect the permission-blocked result marker emitted by
 * `permissionBlockedResult` in `@brainst0rm/tools` registry: a normalized
 * failure with `blocked: true` and a `permissionDecision` of confirm/deny.
 */
function isPermissionBlocked(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return r.blocked === true && r.permissionDecision !== undefined;
}
