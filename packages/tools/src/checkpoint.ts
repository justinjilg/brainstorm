import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { homedir } from 'node:os';

const CHECKPOINT_DIR = join(homedir(), '.brainstorm', 'checkpoints');

/**
 * CheckpointManager — snapshots files before modification.
 * Enables revert to any previous state within a session.
 */
export class CheckpointManager {
  private sessionId: string;
  private sessionDir: string;
  private history: Array<{ timestamp: number; filePath: string; checkpointPath: string }> = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.sessionDir = join(CHECKPOINT_DIR, sessionId);
    mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Snapshot a file before it's modified.
   * Returns the checkpoint path, or null if the file doesn't exist yet (new file).
   */
  snapshot(filePath: string): string | null {
    if (!existsSync(filePath)) return null; // New file, nothing to snapshot

    const timestamp = Date.now();
    const safeName = relative(process.cwd(), filePath).replace(/[/\\]/g, '__');
    const checkpointPath = join(this.sessionDir, `${timestamp}-${safeName}`);

    copyFileSync(filePath, checkpointPath);

    this.history.push({ timestamp, filePath, checkpointPath });
    return checkpointPath;
  }

  /**
   * Revert the most recent change to a file, or the most recent change overall.
   * Returns the file path that was reverted, or null if nothing to revert.
   */
  revertLast(filePath?: string): string | null {
    if (this.history.length === 0) return null;

    let entry;
    if (filePath) {
      // Find most recent checkpoint for this specific file
      let idx = -1;
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].filePath === filePath) { idx = i; break; }
      }
      if (idx === -1) return null;
      entry = this.history[idx];
      this.history.splice(idx, 1);
    } else {
      // Revert most recent change overall
      entry = this.history.pop()!;
    }

    if (existsSync(entry.checkpointPath)) {
      mkdirSync(dirname(entry.filePath), { recursive: true });
      copyFileSync(entry.checkpointPath, entry.filePath);
      return entry.filePath;
    }

    return null;
  }

  /**
   * List all checkpoints in this session.
   */
  list(): Array<{ filePath: string; timestamp: number }> {
    return this.history.map((e) => ({
      filePath: e.filePath,
      timestamp: e.timestamp,
    }));
  }

  /**
   * Get the number of checkpoints in this session.
   */
  count(): number {
    return this.history.length;
  }

  /**
   * Clean up checkpoint files for this session.
   */
  cleanup(): void {
    if (existsSync(this.sessionDir)) {
      const files = readdirSync(this.sessionDir);
      for (const f of files) {
        unlinkSync(join(this.sessionDir, f));
      }
    }
  }
}
