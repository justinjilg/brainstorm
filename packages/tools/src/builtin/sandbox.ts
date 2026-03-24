/**
 * Shell sandbox — blocks dangerous commands before execution.
 *
 * Three levels:
 * - none: no restrictions (current default)
 * - restricted: block dangerous patterns, warn on risky ones
 * - container: (future) Docker isolation
 */

export type SandboxLevel = 'none' | 'restricted' | 'container';

export interface SandboxResult {
  allowed: boolean;
  reason?: string;
}

/** Patterns that are always blocked in restricted mode. */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-\w*r\w*\s+.*)?\/\s*$/, reason: 'Recursive deletion of root filesystem' },
  { pattern: /\brm\s+-\w*rf\w*\s+\//, reason: 'Recursive force deletion from root' },
  { pattern: /\bsudo\b/, reason: 'Elevated privileges not allowed in sandbox' },
  { pattern: /\bchmod\s+777\b/, reason: 'World-writable permissions are insecure' },
  { pattern: /\bmkfs\b/, reason: 'Filesystem creation is destructive' },
  { pattern: /\bdd\s+if=/, reason: 'Raw disk operations blocked' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: 'Fork bomb detected' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Direct device writes blocked' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: 'Piping remote content to shell is risky' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/, reason: 'Piping remote content to shell is risky' },
  { pattern: /\beval\s+"?\$\(.*curl/, reason: 'Eval of remote content blocked' },
  { pattern: /\bshutdown\b/, reason: 'System shutdown blocked' },
  { pattern: /\breboot\b/, reason: 'System reboot blocked' },
  { pattern: /\binit\s+[06]\b/, reason: 'System halt/reboot blocked' },
];

/**
 * Check if a command is allowed under the given sandbox level.
 */
export function checkSandbox(command: string, level: SandboxLevel, projectPath?: string): SandboxResult {
  if (level === 'none') {
    return { allowed: true };
  }

  if (level === 'container') {
    // Container mode not yet implemented — fall back to restricted
    return checkRestricted(command, projectPath);
  }

  return checkRestricted(command, projectPath);
}

function checkRestricted(command: string, projectPath?: string): SandboxResult {
  // Check against blocked patterns
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `Sandbox blocked: ${reason}` };
    }
  }

  // Check for writes outside project directory (heuristic)
  if (projectPath) {
    // Detect absolute path writes that aren't within the project
    const absWritePattern = /(?:>|tee|cp|mv|install)\s+\/?(?:usr|etc|var|opt|tmp|home|root)\//;
    if (absWritePattern.test(command)) {
      return { allowed: false, reason: 'Sandbox blocked: writing outside project directory' };
    }
  }

  return { allowed: true };
}
