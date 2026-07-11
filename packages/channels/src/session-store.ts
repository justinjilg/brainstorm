/**
 * ChannelSessionStore — maps a channel-platform conversation thread
 * (channel type + team + channel + thread key) to a Brainstorm
 * conversation id, so a Slack thread (etc.) keeps talking to the same
 * agent conversation across multiple inbound messages.
 *
 * Persisted in the shared better-sqlite3 database so bindings survive
 * process restarts.
 */

import type Database from "better-sqlite3";

export const CHANNELS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS channel_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_type TEXT NOT NULL,
  team_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (channel_type, team_id, channel_id, thread_key)
);
`;

export interface ChannelSessionKey {
  channelType: string;
  teamId?: string;
  channelId: string;
  threadKey: string;
}

export class ChannelSessionStore {
  constructor(private db: Database.Database) {
    this.db.exec(CHANNELS_MIGRATION_SQL);
  }

  resolve(key: ChannelSessionKey): string | null {
    const row = this.db
      .prepare(
        `SELECT conversation_id FROM channel_sessions
         WHERE channel_type = ? AND team_id = ? AND channel_id = ? AND thread_key = ?`,
      )
      .get(key.channelType, key.teamId ?? "", key.channelId, key.threadKey) as
      | { conversation_id: string }
      | undefined;
    return row ? row.conversation_id : null;
  }

  bind(key: ChannelSessionKey, conversationId: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO channel_sessions
           (channel_type, team_id, channel_id, thread_key, conversation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel_type, team_id, channel_id, thread_key)
         DO UPDATE SET conversation_id = excluded.conversation_id, created_at = excluded.created_at`,
      )
      .run(
        key.channelType,
        key.teamId ?? "",
        key.channelId,
        key.threadKey,
        conversationId,
        now,
      );
  }
}
