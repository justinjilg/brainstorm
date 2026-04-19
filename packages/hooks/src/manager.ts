import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@brainst0rm/shared";
import type {
  HookDefinition,
  HookEvent,
  HookResult,
  PermissionDecision,
} from "./types.js";

const execFileAsync = promisify(execFile);
const log = createLogger("hooks");

/** Cache compiled RegExps to avoid recompilation on every hook fire. */
const regexCache = new Map<string, RegExp | null>();

/**
 * Heuristic: reject matchers prone to catastrophic backtracking.
 *
 * The original heuristic only matched two adjacent quantifiers like `++`
 * or `*{`, missing the canonical ReDoS shape `(a+)+` — a quantified group
 * followed by another quantifier — because the `)` separates them. This
 * pattern also catches `(a*)+`, `(.*|x)*`, `(a|b)+`, etc.
 *
 * JS RegExp has no timeout primitive, so the only robust defence is to
 * reject suspect patterns at compile time. Ship with a practical check;
 * anyone who genuinely needs arbitrary regex can graduate the matcher
 * runner to a worker-thread timeout later.
 */
function looksLikeRedos(pattern: string): boolean {
  // Adjacent quantifiers: "*+", "++", "*{", etc.
  if (/(\+|\*|\{)\s*(\+|\*|\{)/.test(pattern)) return true;
  // A group followed by a repetition quantifier — the (a+)+ shape.
  // Only flag when something inside the group is itself quantified,
  // which is what actually backtracks. Non-quantified groups like
  // (abc)+ are safe.
  if (/\([^)]*[*+?{][^)]*\)[*+?{]/.test(pattern)) return true;
  return false;
}

function getCachedRegex(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern)!;
  if (looksLikeRedos(pattern)) {
    log.warn(
      { pattern },
      "Rejected hook matcher — potential ReDoS (nested/stacked quantifiers)",
    );
    regexCache.set(pattern, null);
    return null;
  }
  try {
    const re = new RegExp(pattern);
    regexCache.set(pattern, re);
    return re;
  } catch (e) {
    log.warn({ err: e, pattern }, "Invalid hook matcher regex");
    regexCache.set(pattern, null);
    return null;
  }
}

/**
 * HookManager — registers and fires hooks at lifecycle events.
 *
 * Hooks are deterministic automation: they always run when their event fires,
 * unlike LLM decisions which are probabilistic. This is the extensibility
 * foundation for Brainstorm CLI.
 */
export class HookManager {
  private hooks: Array<{ id: string; def: HookDefinition }> = [];
  private nextId = 0;

  /** Register a hook. Returns a hook ID for removal. */
  register(hook: HookDefinition): string {
    const id = `hook-${this.nextId++}`;
    this.hooks.push({ id, def: hook });
    return id;
  }

  /** Remove a hook by ID. Returns true if found and removed. */
  remove(id: string): boolean {
    const idx = this.hooks.findIndex((h) => h.id === id);
    if (idx === -1) return false;
    this.hooks.splice(idx, 1);
    return true;
  }

  /** Register multiple hooks (e.g., from TOML config). */
  registerAll(hooks: HookDefinition[]): void {
    for (const h of hooks) this.register(h);
  }

  /** Get all registered hooks. */
  list(): HookDefinition[] {
    return this.hooks.map((h) => h.def);
  }

  /**
   * Fire all hooks matching an event.
   *
   * For PreToolUse: if any blocking hook fails, returns blocked=true.
   * For PostToolUse: runs all hooks, failures are logged but don't block.
   */
  async fire(
    event: HookEvent,
    context?: { toolName?: string; filePath?: string; [key: string]: unknown },
  ): Promise<HookResult[]> {
    const matching = this.hooks
      .map((h) => h.def)
      .filter((h) => {
        if (h.event !== event) return false;
        if (h.matcher) {
          // For subagent hooks, match against subagent type
          const matchTarget =
            event === "SubagentStart" || event === "SubagentStop"
              ? (context?.subagentType as string)
              : context?.toolName;
          if (matchTarget) {
            const re = getCachedRegex(h.matcher);
            if (!re) return false;
            return re.test(matchTarget);
          }
        }
        return true;
      });

    const results: HookResult[] = [];

    for (const hook of matching) {
      const start = Date.now();
      const hookId = `${hook.event}:${hook.command.slice(0, 30)}`;

      if (hook.type === "command") {
        try {
          // Expand variables in command (shell-escaped to prevent injection).
          // Function-form replacement — the STRING form interprets
          // $1/$2/$&/$`/$' in the REPLACEMENT as regex backreferences,
          // so a shellEscape() output containing literal `$` (e.g.,
          // a file path like `/Users/me/$Recycle.Bin/foo`) would be
          // mangled. With the function form, the returned string is
          // inserted verbatim — no $-pattern interpretation.
          let cmd = hook.command;
          if (context?.filePath) {
            const escaped = shellEscape(context.filePath);
            cmd = cmd.replace(/\$FILE/g, () => escaped);
          }
          if (context?.toolName) {
            const escaped = shellEscape(context.toolName);
            cmd = cmd.replace(/\$TOOL/g, () => escaped);
          }
          if (context?.subagentType) {
            const escaped = shellEscape(String(context.subagentType));
            cmd = cmd.replace(/\$SUBAGENT_TYPE/g, () => escaped);
          }
          if (context?.subagentCost !== undefined) {
            const escaped = shellEscape(String(context.subagentCost));
            cmd = cmd.replace(/\$SUBAGENT_COST/g, () => escaped);
          }
          if (context?.subagentModel) {
            const escaped = shellEscape(String(context.subagentModel));
            cmd = cmd.replace(/\$SUBAGENT_MODEL/g, () => escaped);
          }

          const { stdout, stderr } = await execFileAsync(
            "/bin/sh",
            ["-c", cmd],
            {
              timeout: 10_000,
              cwd: process.cwd(),
            },
          );

          // Parse permission decision from stdout (e.g., "PERMISSION:deny")
          const permissionDecision = parsePermissionDecision(stdout);

          results.push({
            hookId,
            event,
            success: true,
            output: stdout.trim(),
            durationMs: Date.now() - start,
            ...(permissionDecision ? { permissionDecision } : {}),
          });

          // A hook returning PERMISSION:deny blocks even if the hook itself "succeeded"
          if (permissionDecision === "deny" && event === "PreToolUse") {
            results[results.length - 1].blocked = true;
            break;
          }
        } catch (err: any) {
          const blocked = hook.blocking && event === "PreToolUse";
          results.push({
            hookId,
            event,
            success: false,
            error: err.stderr || err.message,
            durationMs: Date.now() - start,
            blocked,
          });

          if (blocked) break; // Stop processing further hooks
        }
      } else if (hook.type === "function" && hook.fn) {
        // Function hooks run in-process — no shell overhead.
        // Used for graph enrichment, auto-reindex, and other fast callbacks.
        try {
          const fnResult = await hook.fn(context ?? {});
          results.push({
            ...fnResult,
            hookId,
            event,
            durationMs: Date.now() - start,
          });

          if (fnResult.blocked && event === "PreToolUse") break;
        } catch (err: any) {
          const blocked = hook.blocking && event === "PreToolUse";
          results.push({
            hookId,
            event,
            success: false,
            error: err.message,
            durationMs: Date.now() - start,
            blocked,
          });
          if (blocked) break;
        }
      } else if (hook.type === "prompt") {
        // Prompt hooks require an LLM call — log warning until implemented
        log.warn(
          { hookId, event },
          'Prompt hook type not yet implemented — skipping. Use "command" type instead.',
        );
        results.push({
          hookId,
          event,
          success: false,
          error:
            'Prompt hook type not yet implemented. Use "command" type for now.',
          durationMs: Date.now() - start,
        });
      }
    }

    return results;
  }

  /** Check if any PreToolUse hook blocked the operation. */
  isBlocked(results: HookResult[]): boolean {
    return results.some((r) => r.blocked);
  }

  /**
   * Get the strongest permission decision from hook results.
   * Priority: deny > ask > allow > undefined (no decision).
   * Hooks fire before bypassPermissions mode — a hook deny overrides everything.
   */
  getPermissionDecision(results: HookResult[]): PermissionDecision | undefined {
    let decision: PermissionDecision | undefined;
    for (const r of results) {
      if (!r.permissionDecision) continue;
      if (r.permissionDecision === "deny") return "deny"; // strongest — short-circuit
      if (r.permissionDecision === "ask") decision = "ask";
      else if (!decision) decision = r.permissionDecision;
    }
    return decision;
  }
}

/**
 * Parse a permission decision from hook stdout.
 * Looks for "PERMISSION:allow", "PERMISSION:deny", or "PERMISSION:ask" on any line.
 * This enables hooks to dynamically control tool permissions.
 */
function parsePermissionDecision(
  stdout: string,
): PermissionDecision | undefined {
  const match = stdout.match(/PERMISSION:(allow|deny|ask)/i);
  if (!match) return undefined;
  return match[1].toLowerCase() as PermissionDecision;
}

/**
 * Escape a string for safe inclusion in a shell command.
 * Wraps in single quotes and escapes internal single quotes.
 * Prevents command injection via $FILE, $TOOL, etc.
 */
function shellEscape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
