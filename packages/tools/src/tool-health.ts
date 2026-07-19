/**
 * Session-level tool health tracker.
 * Records success/failure per tool so the agent knows which tools are working
 * and can avoid calling broken ones.
 */

export interface ToolHealthEntry {
  successes: number;
  failures: number;
  lastError?: string;
  lastFailure?: number;
}

export class ToolHealthTracker {
  private entries = new Map<string, ToolHealthEntry>();

  recordSuccess(toolName: string): void {
    const entry = this.getOrCreate(toolName);
    entry.successes++;
  }

  recordFailure(toolName: string, error: string): void {
    const entry = this.getOrCreate(toolName);
    entry.failures++;
    entry.lastError = error;
    entry.lastFailure = Date.now();
  }

  /** Tools with 2+ consecutive failures and no recent successes. */
  getUnhealthy(): Array<{ name: string; error: string }> {
    const result: Array<{ name: string; error: string }> = [];
    for (const [name, entry] of this.entries) {
      // Unhealthy: 2+ failures AND failure rate > 50%
      if (entry.failures >= 2 && entry.failures > entry.successes && entry.lastError) {
        result.push({ name, error: entry.lastError });
      }
    }
    return result;
  }

  /** Get health summary for all tracked tools. */
  getHealthMap(): Record<string, ToolHealthEntry> {
    return Object.fromEntries(this.entries);
  }

  /** Format unhealthy tools as a context string for system prompt injection. */
  formatUnhealthyContext(): string {
    const unhealthy = this.getUnhealthy();
    if (unhealthy.length === 0) return '';
    const items = unhealthy.map((t) => `${t.name}: ${t.error}`).join('; ');
    return `[Unhealthy tools — avoid calling these: ${items}]`;
  }

  clear(): void {
    this.entries.clear();
  }

  private getOrCreate(toolName: string): ToolHealthEntry {
    let entry = this.entries.get(toolName);
    if (!entry) {
      entry = { successes: 0, failures: 0 };
      this.entries.set(toolName, entry);
    }
    return entry;
  }
}

/**
 * Per-session trackers. A single global singleton meant concurrent sessions
 * commingled tool success/failure stats (one session's failures skewed
 * another's unhealthy-tool list). Keyed by session id with an LRU bound.
 */
import { getSessionId } from "./session-context.js";

const MAX_TRACKED_SESSIONS = 256;
const trackers = new Map<string, ToolHealthTracker>();

export function getToolHealthTracker(): ToolHealthTracker {
  const sessionId = getSessionId();
  let t = trackers.get(sessionId);
  if (!t) {
    if (trackers.size >= MAX_TRACKED_SESSIONS) {
      const oldest = trackers.keys().next().value;
      if (oldest !== undefined) trackers.delete(oldest);
    }
    t = new ToolHealthTracker();
    trackers.set(sessionId, t);
  }
  return t;
}

/** Reset (clear) the current session's tracker. */
export function resetToolHealthTracker(
  sessionId: string = getSessionId(),
): void {
  trackers.delete(sessionId);
}
