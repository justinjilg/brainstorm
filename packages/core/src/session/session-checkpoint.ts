/**
 * Session Checkpoint Recovery — survive crashes and accidental closes.
 *
 * Periodically serializes session state to SQLite so long sessions
 * can be resumed after CLI crashes, network drops, or terminal closes.
 *
 * Inspired by DeerFlow's LangGraph checkpoint layer, adapted for
 * Brainstorm's SQLite-based persistence.
 */

import type { ConversationMessage } from './manager.js';

export interface SessionCheckpointData {
  sessionId: string;
  turnNumber: number;
  conversationHistory: ConversationMessage[];
  scratchpad: Record<string, string>;
  filesRead: string[];
  filesWritten: string[];
  buildStatus: string;
  totalCost: number;
  projectPath: string;
}

/**
 * Manages session checkpoints in SQLite.
 */
export class SessionCheckpointer {
  private db: any; // better-sqlite3 Database
  private saveInterval: number;
  private lastSaveTurn = 0;

  /**
   * @param db - better-sqlite3 database instance
   * @param saveInterval - Save every N turns (default: 5)
   */
  constructor(db: any, saveInterval = 5) {
    this.db = db;
    this.saveInterval = saveInterval;
  }

  /**
   * Save a checkpoint if enough turns have passed since the last save.
   */
  saveIfNeeded(data: SessionCheckpointData): boolean {
    if (data.turnNumber - this.lastSaveTurn < this.saveInterval) {
      return false;
    }
    return this.save(data);
  }

  /**
   * Force-save a checkpoint regardless of interval.
   */
  save(data: SessionCheckpointData): boolean {
    try {
      const stateJson = JSON.stringify({
        conversationHistory: data.conversationHistory,
        scratchpad: data.scratchpad,
        filesRead: data.filesRead,
        filesWritten: data.filesWritten,
        buildStatus: data.buildStatus,
        totalCost: data.totalCost,
        projectPath: data.projectPath,
      });

      this.db
        .prepare(
          'INSERT INTO session_checkpoints (session_id, turn_number, state_json) VALUES (?, ?, ?)',
        )
        .run(data.sessionId, data.turnNumber, stateJson);

      this.lastSaveTurn = data.turnNumber;

      // Keep only the 3 most recent checkpoints per session
      this.db
        .prepare(
          `DELETE FROM session_checkpoints
           WHERE session_id = ?
           AND id NOT IN (
             SELECT id FROM session_checkpoints
             WHERE session_id = ?
             ORDER BY turn_number DESC
             LIMIT 3
           )`,
        )
        .run(data.sessionId, data.sessionId);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load the most recent checkpoint for a session.
   */
  load(sessionId: string): SessionCheckpointData | null {
    try {
      const row = this.db
        .prepare(
          'SELECT session_id, turn_number, state_json FROM session_checkpoints WHERE session_id = ? ORDER BY turn_number DESC LIMIT 1',
        )
        .get(sessionId) as { session_id: string; turn_number: number; state_json: string } | undefined;

      if (!row) return null;

      const state = JSON.parse(row.state_json);
      return {
        sessionId: row.session_id,
        turnNumber: row.turn_number,
        ...state,
      };
    } catch {
      return null;
    }
  }

  /**
   * Find sessions that have checkpoints but didn't end cleanly.
   * Returns sessions with checkpoints newer than maxAgeMs.
   */
  listRecoverable(maxAgeMs = 24 * 60 * 60 * 1000): Array<{
    sessionId: string;
    turnNumber: number;
    createdAt: number;
    projectPath: string;
  }> {
    try {
      const cutoff = Math.floor((Date.now() - maxAgeMs) / 1000);
      const rows = this.db
        .prepare(
          `SELECT DISTINCT session_id, turn_number, created_at, state_json
           FROM session_checkpoints
           WHERE created_at > ?
           ORDER BY created_at DESC`,
        )
        .all(cutoff) as Array<{ session_id: string; turn_number: number; created_at: number; state_json: string }>;

      return rows.map((row) => {
        const state = JSON.parse(row.state_json);
        return {
          sessionId: row.session_id,
          turnNumber: row.turn_number,
          createdAt: row.created_at,
          projectPath: state.projectPath ?? '',
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Remove all checkpoints for a session (call on clean exit).
   */
  cleanup(sessionId: string): void {
    try {
      this.db.prepare('DELETE FROM session_checkpoints WHERE session_id = ?').run(sessionId);
    } catch {
      // Best effort
    }
  }

  /**
   * Remove all checkpoints older than maxAgeMs.
   */
  cleanupOld(maxAgeMs = 24 * 60 * 60 * 1000): number {
    try {
      const cutoff = Math.floor((Date.now() - maxAgeMs) / 1000);
      const result = this.db.prepare('DELETE FROM session_checkpoints WHERE created_at < ?').run(cutoff);
      return result.changes;
    } catch {
      return 0;
    }
  }
}
