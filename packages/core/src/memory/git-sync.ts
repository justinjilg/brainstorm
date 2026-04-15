/**
 * Git Memory Sync — orchestrates push/pull with rate limiting.
 *
 * Wraps the lower-level git.ts functions into a coherent sync workflow:
 * - syncBeforeRead: pull from remote (rate-limited to max 1 pull/60s)
 * - syncAfterWrite: commit + push to remote
 *
 * Relationship with gateway sync:
 * - Git sync = team/device sharing (pull/push to git remote)
 * - Gateway sync = cloud RMM sharing (fire-and-forget push to BR API)
 * - Both can coexist. Git pull runs first, then gateway push.
 * - Quarantine tier is excluded from both (same existing rule).
 */

import { createLogger } from "@brainst0rm/shared";
import {
  configureRemote,
  hasRemote,
  commitMemoryChange,
  pullChanges,
  pushChanges,
  resolveConflicts,
} from "./git.js";

const log = createLogger("git-sync");

export class GitMemorySync {
  private lastPullAt = 0;
  private readonly pullCooldownMs: number;

  constructor(
    private memoryDir: string,
    private remoteUrl?: string,
    private branch = "main",
    options?: { pullCooldownMs?: number },
  ) {
    this.pullCooldownMs = options?.pullCooldownMs ?? 60_000;

    // Configure remote on construction if URL provided
    if (remoteUrl) {
      configureRemote(memoryDir, remoteUrl);
    }
  }

  /** Whether a remote is configured and sync is active. */
  isActive(): boolean {
    return !!this.remoteUrl || hasRemote(this.memoryDir);
  }

  /**
   * Pull from remote before reading memory.
   * Rate-limited to avoid hammering the remote on frequent reads.
   * Conflicts are auto-resolved with last-writer-wins (theirs).
   */
  private _pulling = false;

  syncBeforeRead(): void {
    if (!this.isActive()) return;
    if (this._pulling) return; // Prevent parallel pull race condition

    const now = Date.now();
    if (now - this.lastPullAt < this.pullCooldownMs) return;

    this._pulling = true;
    try {
      const result = pullChanges(this.memoryDir, "origin", this.branch);
      if (!result.success && result.conflicts.length > 0) {
        resolveConflicts(this.memoryDir, "theirs");
      }
      this.lastPullAt = now;
    } finally {
      this._pulling = false;
    }
  }

  /**
   * Commit and push after writing memory.
   * Commits are created by the MemoryManager already via commitMemoryChange().
   * This just pushes them to the remote.
   */
  syncAfterWrite(message?: string): void {
    if (!this.isActive()) return;

    // Ensure any pending changes are committed
    if (message) {
      commitMemoryChange(this.memoryDir, message);
    }

    if (!pushChanges(this.memoryDir, "origin", this.branch)) {
      log.debug("Memory push failed ��� will retry on next write");
    }
  }

  /** Force a pull regardless of cooldown. */
  forcePull(): void {
    if (!this.isActive()) return;
    const result = pullChanges(this.memoryDir, "origin", this.branch);
    if (!result.success && result.conflicts.length > 0) {
      resolveConflicts(this.memoryDir, "theirs");
    }
    this.lastPullAt = Date.now();
  }
}
