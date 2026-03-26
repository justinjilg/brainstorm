/**
 * Loop Detector — detects repetitive agent behavior within a single turn.
 *
 * Tracks consecutive tool calls and emits warnings when the agent appears stuck:
 * - N consecutive reads with no write → nudge to write
 * - Same file read twice → warn about duplicate read
 * - Same tool called N times in a row → warn about potential loop
 */

export interface LoopWarning {
  type: 'consecutive-reads' | 'duplicate-read' | 'tool-repeat';
  message: string;
}

export class LoopDetector {
  private recentTools: string[] = [];
  private filesReadThisTurn = new Set<string>();
  private writesSinceLastCheck = 0;
  private readonly readThreshold: number;
  private readonly repeatThreshold: number;

  constructor(readThreshold = 4, repeatThreshold = 3) {
    this.readThreshold = readThreshold;
    this.repeatThreshold = repeatThreshold;
  }

  /** Record a tool call and check for loop patterns. Returns warnings if any. */
  recordToolCall(toolName: string, filePath?: string): LoopWarning[] {
    this.recentTools.push(toolName);
    const warnings: LoopWarning[] = [];

    // Track writes
    if (toolName === 'file_write' || toolName === 'file_edit' || toolName === 'multi_edit' || toolName === 'batch_edit') {
      this.writesSinceLastCheck = this.recentTools.length;
    }

    // Check: duplicate file read
    if (toolName === 'file_read' && filePath) {
      if (this.filesReadThisTurn.has(filePath)) {
        warnings.push({
          type: 'duplicate-read',
          message: `You already read "${filePath}" this turn. Use the content from before.`,
        });
      }
      this.filesReadThisTurn.add(filePath);
    }

    // Check: consecutive reads without writing
    const readsSinceWrite = this.countConsecutiveReads();
    if (readsSinceWrite >= this.readThreshold) {
      warnings.push({
        type: 'consecutive-reads',
        message: `You've read ${readsSinceWrite} files without writing. Consider making changes now.`,
      });
    }

    // Check: same tool called N times in a row
    if (this.recentTools.length >= this.repeatThreshold) {
      const last = this.recentTools.slice(-this.repeatThreshold);
      if (last.every((t) => t === last[0])) {
        warnings.push({
          type: 'tool-repeat',
          message: `"${last[0]}" called ${this.repeatThreshold} times in a row. Consider a different approach.`,
        });
      }
    }

    return warnings;
  }

  reset(): void {
    this.recentTools = [];
    this.filesReadThisTurn.clear();
    this.writesSinceLastCheck = 0;
  }

  private countConsecutiveReads(): number {
    let count = 0;
    for (let i = this.recentTools.length - 1; i >= 0; i--) {
      if (this.recentTools[i] === 'file_read' || this.recentTools[i] === 'grep' || this.recentTools[i] === 'glob') {
        count++;
      } else if (this.recentTools[i] === 'file_write' || this.recentTools[i] === 'file_edit' || this.recentTools[i] === 'multi_edit' || this.recentTools[i] === 'batch_edit') {
        break; // Stop counting at the last write
      } else {
        // Other tools (shell, git, etc.) don't break the read streak
        count++;
      }
    }
    return count;
  }
}
