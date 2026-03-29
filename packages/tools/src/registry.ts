import { tool } from "ai";
import type { ToolPermission } from "@brainst0rm/shared";
import type { BrainstormToolDef } from "./base.js";
import { getToolHealthTracker } from "./tool-health.js";

export type PermissionCheckFn = (
  toolName: string,
  toolPermission: ToolPermission,
) => "allow" | "confirm" | "deny";

/**
 * Sliding-window rate limiter per tool.
 * Prevents runaway loops from exhausting resources by capping calls/minute.
 */
export class ToolRateLimiter {
  private windows = new Map<string, number[]>();
  private maxPerMinute: number;

  constructor(maxPerMinute = 20) {
    this.maxPerMinute = maxPerMinute;
  }

  /** Returns true if the call is allowed, false if rate-limited. */
  check(toolName: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    let timestamps = this.windows.get(toolName);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(toolName, timestamps);
    }
    // Evict old entries
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= this.maxPerMinute) {
      return false;
    }
    timestamps.push(now);
    return true;
  }

  /** Reset all windows (e.g., on session start). */
  reset(): void {
    this.windows.clear();
  }
}

let _rateLimiter: ToolRateLimiter | null = null;

export function getToolRateLimiter(): ToolRateLimiter {
  if (!_rateLimiter) _rateLimiter = new ToolRateLimiter();
  return _rateLimiter;
}

/**
 * Normalize tool results into a consistent format the model can parse.
 * Wraps the raw result to always include an `ok` field for reliable success/failure detection.
 */
function normalizeResult(raw: any): any {
  if (raw == null) return { ok: true };

  // Already has 'error' or 'message' key → it's a failure
  if (raw.error) {
    return { ok: false, error: raw.error, ...raw };
  }
  if (raw.message && !raw.ok && !("exitCode" in raw)) {
    return { ok: false, error: raw.message, ...raw };
  }

  // Shell tool: check exitCode
  if ("exitCode" in raw && raw.exitCode !== 0) {
    return {
      ok: false,
      error: raw.stderr || `Exit code ${raw.exitCode}`,
      ...raw,
    };
  }

  // Blocked tool
  if (raw.blocked) {
    return {
      ok: false,
      error: raw.error ?? raw.stderr ?? "Tool blocked",
      ...raw,
    };
  }

  // Everything else is success
  return { ok: true, ...raw };
}

export class ToolRegistry {
  private tools = new Map<string, BrainstormToolDef>();

  register(tool: BrainstormToolDef): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): BrainstormToolDef | undefined {
    return this.tools.get(name);
  }

  getAll(): BrainstormToolDef[] {
    return Array.from(this.tools.values());
  }

  toAISDKTools(): Record<string, ReturnType<BrainstormToolDef["toAISDKTool"]>> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      result[name] = tool.toAISDKTool();
    }
    return result;
  }

  /**
   * Return AI SDK tools filtered to only the named tools.
   * Used by subagent types to restrict tool access.
   */
  toAISDKToolsFiltered(
    allowedNames: string[],
  ): Record<string, ReturnType<BrainstormToolDef["toAISDKTool"]>> {
    const allowed = new Set(allowedNames);
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      if (allowed.has(name)) {
        result[name] = tool.toAISDKTool();
      }
    }
    return result;
  }

  getPermitted(
    overrides?: Record<string, ToolPermission>,
  ): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      const permission = overrides?.[name] ?? tool.permission;
      if (permission !== "deny") {
        result[name] = tool.toAISDKTool();
      }
    }
    return result;
  }

  /**
   * Return AI SDK tools with permission checks wrapping each execute.
   * Tools denied by the check return an error message instead of executing.
   */
  toAISDKToolsWithPermissions(
    check: PermissionCheckFn,
    allowedNames?: string[],
  ): Record<string, any> {
    const allowed = allowedNames ? new Set(allowedNames) : null;
    const result: Record<string, any> = {};
    for (const [name, toolDef] of this.tools) {
      if (allowed && !allowed.has(name)) continue;
      result[name] = tool({
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
        execute: async (input: any) => {
          const decision = check(name, toolDef.permission);
          if (decision === "deny") {
            const result = normalizeResult({
              error: `Tool '${name}' is blocked in the current permission mode.`,
              blocked: true,
            });
            getToolHealthTracker().recordFailure(name, result.error);
            return result;
          }
          if (!getToolRateLimiter().check(name)) {
            const msg = `Tool '${name}' rate-limited (max ${getToolRateLimiter()["maxPerMinute"]}/min). Wait before retrying.`;
            getToolHealthTracker().recordFailure(name, msg);
            return normalizeResult({ error: msg, blocked: true });
          }
          try {
            const raw = await toolDef.execute(input);
            const result = normalizeResult(raw);
            if (result.ok) {
              getToolHealthTracker().recordSuccess(name);
            } else {
              getToolHealthTracker().recordFailure(
                name,
                result.error ?? "unknown error",
              );
            }
            return result;
          } catch (err: any) {
            const result = normalizeResult({
              error: err.message ?? String(err),
            });
            getToolHealthTracker().recordFailure(name, result.error);
            return result;
          }
        },
      });
    }
    return result;
  }

  listTools(): Array<{
    name: string;
    description: string;
    permission: ToolPermission;
  }> {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      permission: t.permission,
    }));
  }
}
