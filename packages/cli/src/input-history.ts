/**
 * Input history with persistence.
 *
 * Keeps the last N inputs in memory and persists to disk.
 * Up/Down arrow navigation cycles through previous inputs.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile } from "@brainst0rm/shared";

const DEFAULT_HISTORY_DIR = join(homedir(), ".brainstorm");
const DEFAULT_HISTORY_FILE = join(DEFAULT_HISTORY_DIR, "input-history.json");
const MAX_MEMORY = 100;
const MAX_PERSIST = 500;

export class InputHistory {
  private entries: string[] = [];
  private cursor = -1;
  private draft = "";
  private readonly historyDir: string;
  private readonly historyFile: string;

  /**
   * @param historyFile Optional override path. Primary use is test
   *   isolation — the default reads homedir() at module load, which
   *   makes it impossible to redirect writes in-process. Callers
   *   should leave this unset in production.
   */
  constructor(historyFile?: string) {
    this.historyFile = historyFile ?? DEFAULT_HISTORY_FILE;
    this.historyDir = this.historyFile.replace(/\/[^/]*$/, "");
    this.load();
  }

  /**
   * Add an input to history. Deduplicates consecutive identical entries.
   */
  push(input: string): void {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Don't add if identical to most recent
    if (
      this.entries.length > 0 &&
      this.entries[this.entries.length - 1] === trimmed
    ) {
      this.resetCursor();
      return;
    }

    this.entries.push(trimmed);

    // Trim memory buffer
    if (this.entries.length > MAX_MEMORY) {
      this.entries = this.entries.slice(-MAX_MEMORY);
    }

    this.resetCursor();
    this.save();
  }

  /**
   * Navigate up (older). Returns the entry to display, or null if at the end.
   */
  up(currentInput: string): string | null {
    if (this.entries.length === 0) return null;

    // Save current input as draft on first up
    if (this.cursor === -1) {
      this.draft = currentInput;
    }

    const nextCursor =
      this.cursor === -1 ? this.entries.length - 1 : this.cursor - 1;
    if (nextCursor < 0) return null;

    this.cursor = nextCursor;
    return this.entries[this.cursor];
  }

  /**
   * Navigate down (newer). Returns the entry to display, or the draft if at bottom.
   */
  down(): string | null {
    if (this.cursor === -1) return null;

    this.cursor += 1;

    if (this.cursor >= this.entries.length) {
      this.cursor = -1;
      return this.draft;
    }

    return this.entries[this.cursor];
  }

  /**
   * Reset cursor position (called after submitting input).
   */
  resetCursor(): void {
    this.cursor = -1;
    this.draft = "";
  }

  /**
   * Get all entries (for debugging/export).
   */
  getAll(): string[] {
    return [...this.entries];
  }

  private load(): void {
    try {
      if (existsSync(this.historyFile)) {
        const data = JSON.parse(readFileSync(this.historyFile, "utf-8"));
        if (Array.isArray(data)) {
          this.entries = data.slice(-MAX_MEMORY);
        }
      }
    } catch {
      // Corrupt file — start fresh
      this.entries = [];
    }
  }

  private save(): void {
    try {
      if (!existsSync(this.historyDir))
        mkdirSync(this.historyDir, { recursive: true });

      // Load full history from disk, append ONLY the just-pushed entry, trim.
      //
      // Previously this merge appended EVERY entry in `this.entries` (up to
      // 100 items loaded on startup) to `fullHistory`, deduped only against
      // the running tail. So each save re-appended the whole in-memory
      // buffer, and disk grew at O(N²) until MAX_PERSIST clipped the tail —
      // the user's history became `[A, B, C, A, B, C, D, A, B, C, D, E, …]`.
      // save() is called once per push() so only the last entry is new; the
      // rest are already on disk (they came from load() or a prior save()).
      let fullHistory: string[] = [];
      try {
        if (existsSync(this.historyFile)) {
          const data = JSON.parse(readFileSync(this.historyFile, "utf-8"));
          if (Array.isArray(data)) fullHistory = data;
        }
      } catch {
        // Start fresh
      }

      const merged = [...fullHistory];
      const latest = this.entries[this.entries.length - 1];
      if (latest !== undefined && merged[merged.length - 1] !== latest) {
        merged.push(latest);
      }

      const trimmed = merged.slice(-MAX_PERSIST);
      // atomicWriteFile uses a pid+uuid temp suffix so two CLI instances
      // writing history simultaneously cannot clobber each other via the
      // old shared ".tmp" path. A collision there previously left
      // input-history.json corrupt and loadPersisted() silently reset
      // entries to [], losing the user's history.
      atomicWriteFile(this.historyFile, JSON.stringify(trimmed));
    } catch {
      // Non-fatal — history is a convenience feature
    }
  }
}
