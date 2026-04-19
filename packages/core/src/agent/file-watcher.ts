/**
 * Semantic File Watcher — detect external file changes between turns.
 * Uses fs.watch (no external dependencies) to track changes in the project.
 * Filters out node_modules, .git, dist, .next, and other noise.
 */

import { watch, type FSWatcher } from "node:fs";
import { join, relative } from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  ".turbo",
  ".cache",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".pytest_cache",
]);

export interface FileChange {
  path: string;
  type: "created" | "modified" | "deleted";
}

const DEBOUNCE_MS = 200;

/**
 * Soft caps on the in-memory tracking sets. Both grow monotonically
 * under adversarial scenarios:
 *   - agentWrites entries get deleted only when fs.watch fires for
 *     them. A write outside projectPath, or to a filtered dir
 *     (node_modules/, dist/, etc.) never triggers the callback, so
 *     its entry stays forever.
 *   - changes accumulates until consumeChanges() runs. A caller
 *     that pauses consuming (e.g., during long compaction) would
 *     grow it indefinitely on a busy filesystem.
 * Both caps use insertion-order eviction (Map/Set iteration order),
 * which approximates LRU well enough for this use.
 */
const MAX_AGENT_WRITES = 500;
const MAX_CHANGES = 1000;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private changes = new Map<string, FileChange["type"]>();
  private agentWrites = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private projectPath: string) {}

  /** Start watching the project directory. */
  start(): void {
    if (this.watcher) return; // Already watching

    try {
      this.watcher = watch(
        this.projectPath,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;

          // Filter out ignored directories
          const parts = filename.split("/");
          if (parts.some((p) => IGNORE_DIRS.has(p))) return;

          // Filter out dot-files and common temp files
          const base = parts[parts.length - 1];
          if (
            base.startsWith(".") ||
            base.endsWith("~") ||
            base.endsWith(".swp")
          )
            return;

          const fullPath = join(this.projectPath, filename);

          // Skip changes made by the agent itself
          if (this.agentWrites.has(fullPath)) {
            this.agentWrites.delete(fullPath);
            return;
          }

          // Debounce: coalesce rapid events for the same file (e.g., save + lint)
          const existing = this.debounceTimers.get(filename);
          if (existing) clearTimeout(existing);

          this.debounceTimers.set(
            filename,
            setTimeout(() => {
              this.debounceTimers.delete(filename);
              const changeType =
                eventType === "rename" ? "created" : "modified";
              // Evict oldest entry when capped — caller may have paused
              // consuming; don't let the buffer grow without bound.
              if (
                this.changes.size >= MAX_CHANGES &&
                !this.changes.has(filename)
              ) {
                const oldest = this.changes.keys().next().value;
                if (oldest !== undefined) this.changes.delete(oldest);
              }
              this.changes.set(filename, changeType);
            }, DEBOUNCE_MS),
          );
        },
      );

      // Don't let the watcher keep the process alive
      this.watcher.unref();
    } catch {
      // fs.watch may not support recursive on all platforms — fail silently
    }
  }

  /** Register a file as written by the agent (to distinguish from external changes). */
  recordAgentWrite(filePath: string): void {
    // Evict oldest entry when capped. agentWrites only drains when
    // fs.watch fires for a registered path — writes outside
    // projectPath or to filtered dirs (node_modules, dist) never
    // trigger the callback, so their entries would otherwise pile up
    // for the life of the process.
    if (
      this.agentWrites.size >= MAX_AGENT_WRITES &&
      !this.agentWrites.has(filePath)
    ) {
      const oldest = this.agentWrites.values().next().value;
      if (oldest !== undefined) this.agentWrites.delete(oldest);
    }
    this.agentWrites.add(filePath);
  }

  /** Consume and return all changes since last call. Clears the buffer. */
  consumeChanges(): FileChange[] {
    const result: FileChange[] = [];
    for (const [path, type] of this.changes) {
      result.push({ path, type });
    }
    this.changes.clear();
    return result;
  }

  /** Format changes as a context string for system prompt injection. */
  formatChanges(): string {
    const changes = this.consumeChanges();
    if (changes.length === 0) return "";

    const items = changes.slice(0, 10).map((c) => {
      const icon =
        c.type === "created" ? "+" : c.type === "deleted" ? "-" : "~";
      return `${icon} ${c.path}`;
    });
    const suffix =
      changes.length > 10 ? ` (and ${changes.length - 10} more)` : "";
    return `[External changes since last turn${suffix}]\n${items.join("\n")}`;
  }

  /** Stop watching. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.changes.clear();
    this.agentWrites.clear();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }
}
