import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Session, Message, CostRecord, TaskType } from '@brainstorm/shared';

// ── Sessions ─────────────────────────────────────────────────────────

export class SessionRepository {
  constructor(private db: Database.Database) {}

  create(projectPath: string): Session {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare('INSERT INTO sessions (id, created_at, updated_at, project_path) VALUES (?, ?, ?, ?)')
      .run(id, now, now, projectPath);
    return { id, createdAt: now, updatedAt: now, projectPath, totalCost: 0, messageCount: 0 };
  }

  get(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectPath: row.project_path,
      totalCost: row.total_cost,
      messageCount: row.message_count,
    };
  }

  updateCost(id: string, cost: number): void {
    this.db
      .prepare('UPDATE sessions SET total_cost = total_cost + ?, updated_at = unixepoch() WHERE id = ?')
      .run(cost, id);
  }

  incrementMessages(id: string): void {
    this.db
      .prepare('UPDATE sessions SET message_count = message_count + 1, updated_at = unixepoch() WHERE id = ?')
      .run(id);
  }

  listRecent(limit = 10): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectPath: row.project_path,
      totalCost: row.total_cost,
      messageCount: row.message_count,
    }));
  }
}

// ── Messages ─────────────────────────────────────────────────────────

export class MessageRepository {
  constructor(private db: Database.Database) {}

  create(sessionId: string, role: Message['role'], content: string, modelId?: string, tokenCount?: number): Message {
    const id = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    this.db
      .prepare('INSERT INTO messages (id, session_id, role, content, model_id, token_count, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, role, content, modelId ?? null, tokenCount ?? null, timestamp);
    return { id, sessionId, role, content, modelId, tokenCount, timestamp };
  }

  listBySession(sessionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC')
      .all(sessionId) as any[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      modelId: row.model_id ?? undefined,
      tokenCount: row.token_count ?? undefined,
      timestamp: row.timestamp,
    }));
  }
}

// ── Cost Records ─────────────────────────────────────────────────────

export class CostRepository {
  constructor(private db: Database.Database) {}

  record(entry: Omit<CostRecord, 'id'>): CostRecord {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO cost_records (id, timestamp, session_id, model_id, provider, input_tokens, output_tokens, cached_tokens, cost, task_type, project_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, entry.timestamp, entry.sessionId, entry.modelId, entry.provider, entry.inputTokens, entry.outputTokens, entry.cachedTokens, entry.cost, entry.taskType, entry.projectPath ?? null);
    return { ...entry, id };
  }

  totalCostToday(): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE timestamp >= ?')
      .get(Math.floor(startOfDay.getTime() / 1000)) as any;
    return row.total;
  }

  totalCostThisMonth(): number {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE timestamp >= ?')
      .get(Math.floor(startOfMonth.getTime() / 1000)) as any;
    return row.total;
  }

  totalCostForSession(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE session_id = ?')
      .get(sessionId) as any;
    return row.total;
  }

  lastForSession(sessionId: string): CostRecord | null {
    const row = this.db
      .prepare('SELECT * FROM cost_records WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1')
      .get(sessionId) as any;
    if (!row) return null;
    return {
      id: row.id, timestamp: row.timestamp, sessionId: row.session_id,
      modelId: row.model_id, provider: row.provider,
      inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens, cost: row.cost,
      taskType: row.task_type, projectPath: row.project_path,
    };
  }

  updateCost(id: string, cost: number): void {
    this.db.prepare('UPDATE cost_records SET cost = ? WHERE id = ?').run(cost, id);
  }

  recentByModel(limit = 20): Array<{ modelId: string; totalCost: number; requestCount: number }> {
    const rows = this.db
      .prepare(`SELECT model_id, SUM(cost) as total_cost, COUNT(*) as request_count FROM cost_records GROUP BY model_id ORDER BY total_cost DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => ({
      modelId: r.model_id,
      totalCost: r.total_cost,
      requestCount: r.request_count,
    }));
  }
}
