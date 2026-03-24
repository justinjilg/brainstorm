import type { ToolPermission } from '@brainstorm/shared';

export type PermissionMode = 'auto' | 'confirm' | 'plan';

const MODE_CYCLE: PermissionMode[] = ['auto', 'confirm', 'plan'];

/**
 * PermissionManager controls tool execution approval.
 *
 * Three modes cycle with Shift+Tab:
 * - auto: all tools execute without asking (fastest, trust the model)
 * - confirm: write/shell tools require [y/n/always] confirmation
 * - plan: only read-only tools allowed (no writes, no shell)
 */
export class PermissionManager {
  private mode: PermissionMode;
  private sessionAlways = new Set<string>(); // tools the user said "always" for this session

  constructor(defaultMode: PermissionMode = 'confirm') {
    this.mode = defaultMode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /** Cycle to the next permission mode. */
  cycle(): PermissionMode {
    const idx = MODE_CYCLE.indexOf(this.mode);
    this.mode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /**
   * Check if a tool is allowed to execute in the current mode.
   * Returns: 'allow' (proceed), 'confirm' (ask user), 'deny' (blocked).
   */
  check(toolName: string, toolPermission: ToolPermission): 'allow' | 'confirm' | 'deny' {
    // Plan mode: only allow 'auto' (read-only) tools
    if (this.mode === 'plan') {
      return toolPermission === 'auto' ? 'allow' : 'deny';
    }

    // Tool explicitly denied in config
    if (toolPermission === 'deny') return 'deny';

    // Auto mode: everything allowed
    if (this.mode === 'auto') return 'allow';

    // Confirm mode: auto tools pass through, confirm tools need approval
    if (toolPermission === 'auto') return 'allow';

    // Check session "always allow" list
    if (this.sessionAlways.has(toolName)) return 'allow';

    return 'confirm';
  }

  /** Mark a tool as "always allow" for this session. */
  alwaysAllow(toolName: string): void {
    this.sessionAlways.add(toolName);
  }

  /** Get description of current mode for TUI display. */
  getModeDescription(): string {
    switch (this.mode) {
      case 'auto': return 'Auto (all tools allowed)';
      case 'confirm': return 'Confirm (approve writes/shell)';
      case 'plan': return 'Plan (read-only)';
    }
  }

  /** Get mode color for TUI. */
  getModeColor(): string {
    switch (this.mode) {
      case 'auto': return 'green';
      case 'confirm': return 'yellow';
      case 'plan': return 'cyan';
    }
  }
}
