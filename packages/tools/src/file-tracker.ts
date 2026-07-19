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

/**
 * Per-session trackers. A single global singleton meant concurrent sessions
 * commingled their file-access history — one session's reads/writes leaked into
 * ANOTHER session's system-prompt manifest. Keyed by the current session id
 * with an LRU bound.
 */
import { getSessionId } from "./session-context.js";

const MAX_TRACKED_SESSIONS = 256;
const trackers = new Map<string, SessionFileTracker>();

export function getFileTracker(): SessionFileTracker {
  const sessionId = getSessionId();
  let t = trackers.get(sessionId);
  if (!t) {
    if (trackers.size >= MAX_TRACKED_SESSIONS) {
      const oldest = trackers.keys().next().value;
      if (oldest !== undefined) trackers.delete(oldest);
    }
    t = new SessionFileTracker();
    trackers.set(sessionId, t);
  }
  return t;
}

/** Reset (clear) the current session's tracker. */
export function resetFileTracker(sessionId: string = getSessionId()): void {
  trackers.delete(sessionId);
}
