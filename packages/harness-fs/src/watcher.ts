import { EventEmitter } from "node:events";
import chokidar, { type FSWatcher } from "chokidar";
import { relative } from "node:path";

/**
 * File watcher abstraction for the harness.
 *
 * Per spec `## Index Coherence and Drift Architecture`:
 *   - Engineering details: chokidar with usePolling: false,
 *     awaitWriteFinish: true, debounced 200ms.
 *   - Above 30k files (Series B), spec calls for swap to native watchers
 *     (fsevents / inotify / ReadDirectoryChangesW). The abstraction here
 *     keeps the swap surface narrow: replace the chokidar internals,
 *     keep the public emit('change' | 'add' | 'unlink') interface.
 *
 * Events emitted:
 *   'add'    — { path, relativePath } — file created
 *   'change' — { path, relativePath } — content modified
 *   'unlink' — { path, relativePath } — file deleted
 *   'ready'  — initial scan complete
 *   'error'  — { error }
 */

export interface HarnessWatcherEvent {
  path: string;
  relativePath: string;
}

export interface HarnessWatcherOptions {
  /**
   * Glob patterns to ignore. Defaults match the harness's own derived
   * artifacts (.harness/index/, .harness/locks/, dist, node_modules).
   */
  ignored?: (string | RegExp)[];
  /**
   * Debounce window in ms; defaults to 200 per spec. Editor save-cycles
   * (vim's swap-and-rename, VSCode's pre-write atomic) emit multiple
   * filesystem events per logical save; debounce coalesces.
   */
  debounceMs?: number;
}

export class HarnessWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs: number;
  private readonly ignored: (string | RegExp)[];

  constructor(
    private readonly harnessRoot: string,
    options: HarnessWatcherOptions = {},
  ) {
    super();
    this.debounceMs = options.debounceMs ?? 200;
    this.ignored = options.ignored ?? [
      // Harness derived state
      /(^|[/\\])\.harness[/\\]index[/\\]/,
      /(^|[/\\])\.harness[/\\]locks[/\\]/,
      // Common ignore patterns
      /(^|[/\\])node_modules[/\\]/,
      /(^|[/\\])\.git[/\\]/,
      /(^|[/\\])dist[/\\]/,
      // OS junk
      /\.DS_Store$/,
    ];
  }

  /**
   * Start watching. Call `stop()` to clean up. Emits 'ready' once initial
   * scan completes; events fired before 'ready' are part of the initial
   * inventory, not real changes.
   */
  start(): void {
    if (this.watcher) {
      throw new Error("HarnessWatcher.start(): already running");
    }
    this.watcher = chokidar.watch(this.harnessRoot, {
      ignored: this.ignored,
      persistent: true,
      ignoreInitial: true, // initial-scan events emitted via 'ready' only
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      usePolling: false,
    });

    this.watcher.on("add", (path) => this.debounce("add", path));
    this.watcher.on("change", (path) => this.debounce("change", path));
    this.watcher.on("unlink", (path) => this.debounce("unlink", path));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.on("error", (err) => this.emit("error", { error: err }));
  }

  async stop(): Promise<void> {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private debounce(event: "add" | "change" | "unlink", path: string): void {
    const key = `${event}:${path}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.emit(event, {
        path,
        relativePath: relative(this.harnessRoot, path),
      } satisfies HarnessWatcherEvent);
    }, this.debounceMs);

    this.debounceTimers.set(key, timer);
  }
}
