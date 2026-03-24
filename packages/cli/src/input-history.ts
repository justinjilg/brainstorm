/**
 * Input history with persistence.
 *
 * Keeps the last N inputs in memory and persists to disk.
 * Up/Down arrow navigation cycles through previous inputs.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HISTORY_DIR = join(homedir(), '.brainstorm');
const HISTORY_FILE = join(HISTORY_DIR, 'input-history.json');
const MAX_MEMORY = 100;
const MAX_PERSIST = 500;

export class InputHistory {
  private entries: string[] = [];
  private cursor = -1;
  private draft = '';

  constructor() {
    this.load();
  }

  /**
   * Add an input to history. Deduplicates consecutive identical entries.
   */
  push(input: string): void {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Don't add if identical to most recent
    if (this.entries.length > 0 && this.entries[this.entries.length - 1] === trimmed) {
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

    const nextCursor = this.cursor === -1 ? this.entries.length - 1 : this.cursor - 1;
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
    this.draft = '';
  }

  /**
   * Get all entries (for debugging/export).
   */
  getAll(): string[] {
    return [...this.entries];
  }

  private load(): void {
    try {
      if (existsSync(HISTORY_FILE)) {
        const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
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
      if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });

      // Load full history from disk, append new entries, trim
      let fullHistory: string[] = [];
      try {
        if (existsSync(HISTORY_FILE)) {
          const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
          if (Array.isArray(data)) fullHistory = data;
        }
      } catch {
        // Start fresh
      }

      // Merge: disk history + memory entries (deduped at tail)
      const merged = [...fullHistory];
      for (const entry of this.entries) {
        if (merged[merged.length - 1] !== entry) {
          merged.push(entry);
        }
      }

      const trimmed = merged.slice(-MAX_PERSIST);
      // Atomic write: temp file + rename prevents corruption on crash
      const tmpFile = HISTORY_FILE + '.tmp';
      writeFileSync(tmpFile, JSON.stringify(trimmed), 'utf-8');
      renameSync(tmpFile, HISTORY_FILE);
    } catch {
      // Non-fatal — history is a convenience feature
    }
  }
}
