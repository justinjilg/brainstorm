/**
 * Hook events fired during the agent lifecycle.
 * Mirrors Claude Code's hook event model for compatibility.
 */
export type HookEvent =
  | 'PreToolUse'      // Before a tool executes — can block or modify
  | 'PostToolUse'     // After a tool succeeds — for side effects (format, lint)
  | 'SessionStart'    // When a session begins or resumes
  | 'SessionEnd'      // When a session ends
  | 'Stop'            // When the agent finishes responding
  | 'PreCompact'      // Before context compaction
  | 'PreCommit';      // Before a git commit

export type HookType = 'command' | 'prompt';

/**
 * Hook definition — matches a lifecycle event and runs an action.
 */
export interface HookDefinition {
  /** Which event triggers this hook. */
  event: HookEvent;
  /** Optional matcher: only fire for specific tool names (regex for PreToolUse/PostToolUse). */
  matcher?: string;
  /** Hook type: 'command' runs a shell command, 'prompt' asks an LLM. */
  type: HookType;
  /** The command to run or prompt to evaluate. */
  command: string;
  /** If true, a failing hook blocks the operation (PreToolUse only). */
  blocking?: boolean;
  /** Human-readable description. */
  description?: string;
}

export interface HookResult {
  hookId: string;
  event: HookEvent;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  blocked?: boolean;
}
