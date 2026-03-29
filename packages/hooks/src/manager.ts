import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@brainstorm/shared";
import type { HookDefinition, HookEvent, HookResult } from "./types.js";

const execFileAsync = promisify(execFile);
const log = createLogger("hooks");

/** Cache compiled RegExps to avoid recompilation on every hook fire. */
const regexCache = new Map<string, RegExp | null>();

/** Simple ReDoS heuristic: reject patterns with nested quantifiers. */
const REDOS_PATTERN = /(\+|\*|\{)\s*(\+|\*|\{)/;

function getCachedRegex(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern)!;
  if (REDOS_PATTERN.test(pattern)) {
    log.warn(
      { pattern },
      "Rejected hook matcher — potential ReDoS (nested quantifiers)",
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
          // Expand variables in command (shell-escaped to prevent injection)
          let cmd = hook.command;
          if (context?.filePath)
            cmd = cmd.replace(/\$FILE/g, shellEscape(context.filePath));
          if (context?.toolName)
            cmd = cmd.replace(/\$TOOL/g, shellEscape(context.toolName));
          if (context?.subagentType)
            cmd = cmd.replace(
              /\$SUBAGENT_TYPE/g,
              shellEscape(String(context.subagentType)),
            );
          if (context?.subagentCost !== undefined)
            cmd = cmd.replace(
              /\$SUBAGENT_COST/g,
              shellEscape(String(context.subagentCost)),
            );
          if (context?.subagentModel)
            cmd = cmd.replace(
              /\$SUBAGENT_MODEL/g,
              shellEscape(String(context.subagentModel)),
            );

          const { stdout, stderr } = await execFileAsync(
            "/bin/sh",
            ["-c", cmd],
            {
              timeout: 10_000,
              cwd: process.cwd(),
            },
          );

          results.push({
            hookId,
            event,
            success: true,
            output: stdout.trim(),
            durationMs: Date.now() - start,
          });
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
