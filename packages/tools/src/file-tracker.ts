/**
 * Session-level file access tracker.
 * Records which files were read/written during the session so the agent
 * knows what it's touched without re-reading.
 */

export class SessionFileTracker {
  private reads = new Set<string>();
  private writes = new Set<string>();

  recordRead(path: string): void {
    this.reads.add(path);
  }

  recordWrite(path: string): void {
    this.writes.add(path);
  }

  getReads(): string[] {
    return [...this.reads];
  }

  getWrites(): string[] {
    return [...this.writes];
  }

  /** Get a compact manifest for system prompt injection. */
  getManifest(): { reads: string[]; writes: string[]; total: number } {
    return {
      reads: this.getReads(),
      writes: this.getWrites(),
      total: this.reads.size + this.writes.size,
    };
  }

  clear(): void {
    this.reads.clear();
    this.writes.clear();
  }
}

/** Global singleton for the current session. */
let tracker: SessionFileTracker | null = null;

export function getFileTracker(): SessionFileTracker {
  if (!tracker) tracker = new SessionFileTracker();
  return tracker;
}

export function resetFileTracker(): void {
  tracker = new SessionFileTracker();
}
