import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Session,
  Message,
  CostRecord,
  TaskType,
} from "@brainst0rm/shared";

// ── Sessions ─────────────────────────────────────────────────────────

export class SessionRepository {
  constructor(private db: Database.Database) {}

  create(projectPath: string): Session {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        "INSERT INTO sessions (id, created_at, updated_at, project_path) VALUES (?, ?, ?, ?)",
      )
      .run(id, now, now, projectPath);
    return {
      id,
      createdAt: now,
      updatedAt: now,
      projectPath,
      totalCost: 0,
      messageCount: 0,
    };
  }

  get(id: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as any;
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
      .prepare(
        "UPDATE sessions SET total_cost = total_cost + ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(cost, id);
  }

  incrementMessages(id: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET message_count = message_count + 1, updated_at = unixepoch() WHERE id = ?",
      )
      .run(id);
  }

  listRecent(limit = 10): Session[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
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

  /** Mark a session as daemon-mode and set initial tick interval. */
  markDaemon(id: string, tickIntervalMs: number): void {
    this.db
      .prepare(
        "UPDATE sessions SET is_daemon = 1, tick_interval_ms = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(tickIntervalMs, id);
  }

  /** Update daemon state after each tick. */
  updateDaemonState(
    id: string,
    state: {
      tickCount: number;
      lastTickAt: number;
      isPaused?: boolean;
      totalCost?: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET
          tick_count = ?, last_tick_at = ?, is_paused = ?,
          total_cost = COALESCE(?, total_cost), updated_at = unixepoch()
        WHERE id = ?`,
      )
      .run(
        state.tickCount,
        state.lastTickAt,
        state.isPaused ? 1 : 0,
        state.totalCost ?? null,
        id,
      );
  }

  /** Get the most recent daemon session for a project (for --continue). */
  getLastDaemon(projectPath: string): Session | null {
    const row = this.db
      .prepare(
        "SELECT * FROM sessions WHERE project_path = ? AND is_daemon = 1 ORDER BY updated_at DESC LIMIT 1",
      )
      .get(projectPath) as any;
    if (!row) return null;
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectPath: row.project_path,
      totalCost: row.total_cost,
      messageCount: row.message_count,
      isDaemon: true,
      tickCount: row.tick_count,
      lastTickAt: row.last_tick_at,
      isPaused: !!row.is_paused,
      tickIntervalMs: row.tick_interval_ms,
    };
  }
}

// ── Messages ─────────────────────────────────────────────────────────

export class MessageRepository {
  constructor(private db: Database.Database) {}

  create(
    sessionId: string,
    role: Message["role"],
    content: string,
    modelId?: string,
    tokenCount?: number,
  ): Message {
    const id = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        "INSERT INTO messages (id, session_id, role, content, model_id, token_count, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        sessionId,
        role,
        content,
        modelId ?? null,
        tokenCount ?? null,
        timestamp,
      );
    return { id, sessionId, role, content, modelId, tokenCount, timestamp };
  }

  listBySession(sessionId: string): Message[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
      )
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

  /** Load only the most recent N messages for a session. Used for lazy loading. */
  listBySessionRecent(sessionId: string, limit = 50): Message[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC",
      )
      .all(sessionId, limit) as any[];
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

  /** Count total messages in a session. */
  countBySession(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?")
      .get(sessionId) as any;
    return row?.count ?? 0;
  }
}

// ── Cost Records ─────────────────────────────────────────────────────

export class CostRepository {
  constructor(private db: Database.Database) {}

  record(entry: Omit<CostRecord, "id">): CostRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO cost_records (id, timestamp, session_id, model_id, provider, input_tokens, output_tokens, cached_tokens, cost, task_type, project_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.timestamp,
        entry.sessionId,
        entry.modelId,
        entry.provider,
        entry.inputTokens,
        entry.outputTokens,
        entry.cachedTokens,
        entry.cost,
        entry.taskType,
        entry.projectPath ?? null,
      );
    return { ...entry, id };
  }

  totalCostToday(): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE timestamp >= ?",
      )
      .get(Math.floor(startOfDay.getTime() / 1000)) as any;
    return row.total;
  }

  totalCostThisMonth(): number {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE timestamp >= ?",
      )
      .get(Math.floor(startOfMonth.getTime() / 1000)) as any;
    return row.total;
  }

  totalCostForSession(sessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost), 0) as total FROM cost_records WHERE session_id = ?",
      )
      .get(sessionId) as any;
    return row.total;
  }

  lastForSession(sessionId: string): CostRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM cost_records WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1",
      )
      .get(sessionId) as any;
    if (!row) return null;
    return {
      id: row.id,
      timestamp: row.timestamp,
      sessionId: row.session_id,
      modelId: row.model_id,
      provider: row.provider,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
      cost: row.cost,
      taskType: row.task_type,
      projectPath: row.project_path,
    };
  }

  updateCost(id: string, cost: number): void {
    this.db
      .prepare("UPDATE cost_records SET cost = ? WHERE id = ?")
      .run(cost, id);
  }

  recentByModel(
    limit = 20,
  ): Array<{ modelId: string; totalCost: number; requestCount: number }> {
    const rows = this.db
      .prepare(
        `SELECT model_id, SUM(cost) as total_cost, COUNT(*) as request_count FROM cost_records GROUP BY model_id ORDER BY total_cost DESC LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map((r) => ({
      modelId: r.model_id,
      totalCost: r.total_cost,
      requestCount: r.request_count,
    }));
  }

  /** Aggregate cost by task type. */
  byTaskType(): Array<{
    taskType: string;
    totalCost: number;
    requestCount: number;
    avgCost: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT task_type, SUM(cost) as total_cost, COUNT(*) as request_count, AVG(cost) as avg_cost FROM cost_records GROUP BY task_type ORDER BY total_cost DESC`,
      )
      .all() as any[];
    return rows.map((r) => ({
      taskType: r.task_type,
      totalCost: r.total_cost,
      requestCount: r.request_count,
      avgCost: r.avg_cost,
    }));
  }

  /** Get cost for a specific task type within a time range. */
  costForTaskType(
    taskType: string,
    sinceTimestamp?: number,
  ): { totalCost: number; requestCount: number } {
    const since = sinceTimestamp ?? 0;
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) as total_cost, COUNT(*) as request_count FROM cost_records WHERE task_type = ? AND timestamp >= ?`,
      )
      .get(taskType, since) as any;
    return { totalCost: row.total_cost, requestCount: row.request_count };
  }

  /** Aggregate cost by project path with 7-day trend. */
  byProject(): Array<{
    projectPath: string;
    totalCost: number;
    requestCount: number;
    last7DaysCost: number;
  }> {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const rows = this.db
      .prepare(
        `SELECT project_path,
                SUM(cost) as total_cost,
                COUNT(*) as request_count,
                SUM(CASE WHEN timestamp >= ? THEN cost ELSE 0 END) as last_7_days_cost
         FROM cost_records
         WHERE project_path IS NOT NULL
         GROUP BY project_path
         ORDER BY total_cost DESC`,
      )
      .all(weekAgo) as any[];
    return rows.map((r: any) => ({
      projectPath: r.project_path,
      totalCost: r.total_cost,
      requestCount: r.request_count,
      last7DaysCost: r.last_7_days_cost,
    }));
  }
}

// ── Routing Outcomes (Thompson Sampling Persistence) ────────────────

export interface AggregatedRoutingStats {
  taskType: string;
  modelId: string;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  avgCost: number;
  samples: number;
}

export class RoutingOutcomeRepository {
  constructor(private db: Database.Database) {}

  /** Record a single routing outcome (writes to model_performance_v2). */
  record(
    modelId: string,
    taskType: string,
    success: boolean,
    latencyMs: number,
    costUsd: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO model_performance_v2 (model_id, task_type, success, latency_ms, cost_usd)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(modelId, taskType, success ? 1 : 0, latencyMs, costUsd);
  }

  /** Load aggregated stats for Thompson sampling — grouped by (task_type, model_id). */
  loadAggregated(): AggregatedRoutingStats[] {
    const rows = this.db
      .prepare(
        `SELECT
           task_type,
           model_id,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
           SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
           AVG(latency_ms) as avg_latency_ms,
           AVG(cost_usd) as avg_cost,
           COUNT(*) as samples
         FROM model_performance_v2
         GROUP BY task_type, model_id
         HAVING samples >= 1`,
      )
      .all() as any[];

    return rows.map((r) => ({
      taskType: r.task_type,
      modelId: r.model_id,
      successes: r.successes,
      failures: r.failures,
      avgLatencyMs: r.avg_latency_ms ?? 0,
      avgCost: r.avg_cost ?? 0,
      samples: r.samples,
    }));
  }
}

// ── Compaction Commits (Reversible Context Collapse) ────────────────

export interface CompactionCommit {
  id: string;
  sessionId: string;
  timestamp: number;
  summary: string;
  originalMessageIds: string[];
  keptCount: number;
  summarizedCount: number;
  droppedCount: number;
  tokensBefore?: number;
  tokensAfter?: number;
}

export class CompactionCommitRepository {
  constructor(private db: Database.Database) {}

  /** Persist a compaction commit before replacing messages. */
  create(commit: CompactionCommit): void {
    this.db
      .prepare(
        `INSERT INTO compaction_commits (id, session_id, timestamp, summary, original_message_ids, kept_count, summarized_count, dropped_count, tokens_before, tokens_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        commit.id,
        commit.sessionId,
        commit.timestamp,
        commit.summary,
        JSON.stringify(commit.originalMessageIds),
        commit.keptCount,
        commit.summarizedCount,
        commit.droppedCount,
        commit.tokensBefore ?? null,
        commit.tokensAfter ?? null,
      );
  }

  /** Get a compaction commit by ID. */
  get(id: string): CompactionCommit | null {
    const row = this.db
      .prepare("SELECT * FROM compaction_commits WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      summary: row.summary,
      originalMessageIds: JSON.parse(row.original_message_ids),
      keptCount: row.kept_count,
      summarizedCount: row.summarized_count,
      droppedCount: row.dropped_count,
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
    };
  }

  /** List all compaction commits for a session. */
  listForSession(sessionId: string): CompactionCommit[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM compaction_commits WHERE session_id = ? ORDER BY timestamp DESC",
      )
      .all(sessionId) as any[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      summary: row.summary,
      originalMessageIds: JSON.parse(row.original_message_ids),
      keptCount: row.kept_count,
      summarizedCount: row.summarized_count,
      droppedCount: row.dropped_count,
      tokensBefore: row.tokens_before,
      tokensAfter: row.tokens_after,
    }));
  }
}

// ── Session Patterns ────────────────────────────────────────────────

export interface SessionPattern {
  id: number;
  projectPath: string;
  patternType:
    | "tool_success"
    | "command_timing"
    | "user_preference"
    | "model_choice";
  key: string;
  value: string;
  confidence: number;
  occurrences: number;
  lastSeen: number;
}

export class PatternRepository {
  constructor(private db: Database.Database) {}

  /** Upsert a pattern — increments occurrences if exists, creates if not. */
  record(
    projectPath: string,
    patternType: SessionPattern["patternType"],
    key: string,
    value: string,
    confidence = 0.5,
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO session_patterns (project_path, pattern_type, key, value, confidence, occurrences, last_seen)
      VALUES (?, ?, ?, ?, ?, 1, unixepoch())
      ON CONFLICT(project_path, pattern_type, key)
      DO UPDATE SET
        value = excluded.value,
        confidence = MIN(1.0, confidence + 0.1),
        occurrences = occurrences + 1,
        last_seen = unixepoch()
    `,
      )
      .run(projectPath, patternType, key, value, confidence);
  }

  /** Get all patterns for a project, optionally filtered by type. */
  getForProject(
    projectPath: string,
    patternType?: SessionPattern["patternType"],
  ): SessionPattern[] {
    const query = patternType
      ? "SELECT * FROM session_patterns WHERE project_path = ? AND pattern_type = ? ORDER BY confidence DESC"
      : "SELECT * FROM session_patterns WHERE project_path = ? ORDER BY confidence DESC";
    const rows = (
      patternType
        ? this.db.prepare(query).all(projectPath, patternType)
        : this.db.prepare(query).all(projectPath)
    ) as any[];

    return rows.map((r) => ({
      id: r.id,
      projectPath: r.project_path,
      patternType: r.pattern_type,
      key: r.key,
      value: r.value,
      confidence: r.confidence,
      occurrences: r.occurrences,
      lastSeen: r.last_seen,
    }));
  }

  /** Decay old patterns — reduce confidence for patterns not seen in N days. */
  decayOld(maxAgeDays = 30): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
    const result = this.db
      .prepare(
        `
      DELETE FROM session_patterns WHERE last_seen < ? AND confidence < 0.3
    `,
      )
      .run(cutoff);
    // Decay confidence for old but still-relevant patterns
    this.db
      .prepare(
        `
      UPDATE session_patterns SET confidence = MAX(0.1, confidence - 0.2)
      WHERE last_seen < ?
    `,
      )
      .run(cutoff);
    return result.changes;
  }

  /** Format patterns as a context string for system prompt injection. */
  formatForPrompt(projectPath: string): string {
    const patterns = this.getForProject(projectPath);
    if (patterns.length === 0) return "";

    const lines: string[] = ["[Project patterns from previous sessions]"];
    for (const p of patterns.slice(0, 10)) {
      lines.push(
        `- ${p.patternType}: ${p.key} → ${p.value} (${p.occurrences}x, confidence ${p.confidence.toFixed(1)})`,
      );
    }
    return lines.join("\n");
  }
}

// ── Session Locks ───────────────────────────────────────────────────

const STALE_LOCK_SECONDS = 5 * 60; // 5 minutes

export class SessionLockManager {
  constructor(private db: Database.Database) {}

  /** Acquire a lock for a session. Returns true if acquired, false if held by another. */
  acquire(sessionId: string, holder: string): boolean {
    this.cleanStale();

    const result = this.db
      .transaction(() => {
        const existing = this.db
          .prepare("SELECT holder FROM session_locks WHERE session_id = ?")
          .get(sessionId) as any;

        if (existing) {
          if (existing.holder === holder) {
            // Renew the lease
            this.db
              .prepare(
                "UPDATE session_locks SET acquired_at = unixepoch() WHERE session_id = ?",
              )
              .run(sessionId);
            return true;
          }
          return false;
        }

        this.db
          .prepare(
            "INSERT INTO session_locks (session_id, holder) VALUES (?, ?)",
          )
          .run(sessionId, holder);
        return true;
      })
      .immediate();

    return result;
  }

  /** Renew the lease on a held lock. Call this periodically during long operations. */
  renew(sessionId: string, holder: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE session_locks SET acquired_at = unixepoch() WHERE session_id = ? AND holder = ?",
      )
      .run(sessionId, holder);
    return result.changes > 0;
  }

  /** Release a lock. Only the holder can release. */
  release(sessionId: string, holder: string): boolean {
    const result = this.db
      .prepare("DELETE FROM session_locks WHERE session_id = ? AND holder = ?")
      .run(sessionId, holder);
    return result.changes > 0;
  }

  /** Check if a session is locked. */
  isLocked(sessionId: string): boolean {
    this.cleanStale();
    const row = this.db
      .prepare("SELECT 1 FROM session_locks WHERE session_id = ?")
      .get(sessionId);
    return !!row;
  }

  /** Remove locks older than STALE_LOCK_SECONDS (stale/crashed processes). */
  private cleanStale(): void {
    const cutoff = Math.floor(Date.now() / 1000) - STALE_LOCK_SECONDS;
    this.db
      .prepare("DELETE FROM session_locks WHERE acquired_at < ?")
      .run(cutoff);
  }
}

// ── Daemon Daily Log ───────────────────────────────────────────────

export interface DailyLogEntry {
  id: number;
  sessionId?: string;
  logDate: string;
  entryTime: number;
  tickNumber?: number;
  eventType: string;
  content: string;
  cost: number;
  modelId?: string;
}

export class DailyLogRepository {
  constructor(private db: Database.Database) {}

  /** Append a log entry. */
  append(entry: Omit<DailyLogEntry, "id">): void {
    this.db
      .prepare(
        `INSERT INTO daemon_daily_log (session_id, log_date, entry_time, tick_number, event_type, content, cost, model_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.sessionId ?? null,
        entry.logDate,
        entry.entryTime,
        entry.tickNumber ?? null,
        entry.eventType,
        entry.content,
        entry.cost,
        entry.modelId ?? null,
      );
  }

  /** Read all entries for today. */
  readToday(): DailyLogEntry[] {
    const today = new Date().toISOString().slice(0, 10);
    return this.readDate(today);
  }

  /** Read entries for a specific date (YYYY-MM-DD). */
  readDate(date: string): DailyLogEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM daemon_daily_log WHERE log_date = ? ORDER BY entry_time ASC",
      )
      .all(date) as any[];
    return rows.map(this.mapRow);
  }

  /** Read entries for a date range (inclusive). */
  readRange(startDate: string, endDate: string): DailyLogEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM daemon_daily_log WHERE log_date >= ? AND log_date <= ? ORDER BY entry_time ASC",
      )
      .all(startDate, endDate) as any[];
    return rows.map(this.mapRow);
  }

  /** Read the last N entries across all dates. */
  readRecent(limit = 50): DailyLogEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM daemon_daily_log ORDER BY entry_time DESC LIMIT ?",
      )
      .all(limit) as any[];
    return rows.map(this.mapRow).reverse();
  }

  private mapRow(row: any): DailyLogEntry {
    return {
      id: row.id,
      sessionId: row.session_id ?? undefined,
      logDate: row.log_date,
      entryTime: row.entry_time,
      tickNumber: row.tick_number ?? undefined,
      eventType: row.event_type,
      content: row.content,
      cost: row.cost,
      modelId: row.model_id ?? undefined,
    };
  }
}

// ── God Mode Audit Repository ──────────────────────────────────────

export interface ChangeSetLogEntry {
  changesetId: string;
  connector: string;
  action: string;
  description: string;
  riskScore: number;
  status: string;
  changesJson: string | null;
  simulationJson: string | null;
  rollbackJson: string | null;
  createdAt: number;
  executedAt: number | null;
  sessionId: string | null;
}

export class ChangeSetLogRepository {
  constructor(private db: Database.Database) {}

  /** Persist a changeset execution to the audit log. */
  log(entry: ChangeSetLogEntry): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO godmode_changeset_log
         (changeset_id, connector, action, description, risk_score, status,
          changes_json, simulation_json, rollback_json, created_at, executed_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.changesetId,
        entry.connector,
        entry.action,
        entry.description,
        entry.riskScore,
        entry.status,
        entry.changesJson,
        entry.simulationJson,
        entry.rollbackJson,
        entry.createdAt,
        entry.executedAt,
        entry.sessionId,
      );
  }

  /** Get recent changeset audit entries. */
  recent(limit = 50, offset = 0): ChangeSetLogEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM godmode_changeset_log ORDER BY created_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset) as any[];
    return rows.map(this.mapRow);
  }

  /** Get entries for a specific connector. */
  byConnector(connector: string, limit = 50): ChangeSetLogEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM godmode_changeset_log WHERE connector = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(connector, limit) as any[];
    return rows.map(this.mapRow);
  }

  /** Count total entries. */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM godmode_changeset_log")
      .get() as any;
    return row?.cnt ?? 0;
  }

  private mapRow(row: any): ChangeSetLogEntry {
    return {
      changesetId: row.changeset_id,
      connector: row.connector,
      action: row.action,
      description: row.description,
      riskScore: row.risk_score,
      status: row.status,
      changesJson: row.changes_json,
      simulationJson: row.simulation_json,
      rollbackJson: row.rollback_json,
      createdAt: row.created_at,
      executedAt: row.executed_at,
      sessionId: row.session_id,
    };
  }
}

// ── Conversations ─────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  name: string;
  description: string;
  projectPath: string;
  tags: string[];
  modelOverride: string | null;
  /** Per-conversation memory overrides: { memoryId: content | null (suppress) } */
  memoryOverrides: Record<string, string | null>;
  metadata: Record<string, unknown>;
  isArchived: boolean;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}

export class ConversationRepository {
  constructor(private db: Database.Database) {}

  create(
    projectPath: string,
    opts?: {
      name?: string;
      description?: string;
      tags?: string[];
      modelOverride?: string | null;
      memoryOverrides?: Record<string, string | null>;
      metadata?: Record<string, unknown>;
    },
  ): Conversation {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO conversations (id, name, description, project_path, tags, model_override, memory_overrides, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts?.name ?? "Untitled",
        opts?.description ?? "",
        projectPath,
        JSON.stringify(opts?.tags ?? []),
        opts?.modelOverride ?? null,
        JSON.stringify(opts?.memoryOverrides ?? {}),
        JSON.stringify(opts?.metadata ?? {}),
        now,
        now,
      );
    return {
      id,
      name: opts?.name ?? "Untitled",
      description: opts?.description ?? "",
      projectPath,
      tags: opts?.tags ?? [],
      modelOverride: opts?.modelOverride ?? null,
      memoryOverrides: opts?.memoryOverrides ?? {},
      metadata: opts?.metadata ?? {},
      isArchived: false,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    };
  }

  get(id: string): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    return this.mapRow(row);
  }

  list(
    projectPath?: string,
    opts?: { includeArchived?: boolean; limit?: number },
  ): Conversation[] {
    const limit = opts?.limit ?? 50;
    const includeArchived = opts?.includeArchived ?? false;
    let query: string;
    let params: any[];

    if (projectPath) {
      query = includeArchived
        ? "SELECT * FROM conversations WHERE project_path = ? ORDER BY updated_at DESC LIMIT ?"
        : "SELECT * FROM conversations WHERE project_path = ? AND is_archived = 0 ORDER BY updated_at DESC LIMIT ?";
      params = [projectPath, limit];
    } else {
      query = includeArchived
        ? "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?"
        : "SELECT * FROM conversations WHERE is_archived = 0 ORDER BY updated_at DESC LIMIT ?";
      params = [limit];
    }

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(this.mapRow);
  }

  update(
    id: string,
    updates: Partial<
      Pick<
        Conversation,
        | "name"
        | "description"
        | "tags"
        | "modelOverride"
        | "memoryOverrides"
        | "metadata"
        | "isArchived"
      >
    >,
  ): Conversation | null {
    const existing = this.get(id);
    if (!existing) return null;

    const merged = { ...existing, ...updates };
    this.db
      .prepare(
        `UPDATE conversations SET
           name = ?, description = ?, tags = ?, model_override = ?,
           memory_overrides = ?, metadata = ?, is_archived = ?,
           updated_at = unixepoch()
         WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.description,
        JSON.stringify(merged.tags),
        merged.modelOverride,
        JSON.stringify(merged.memoryOverrides),
        JSON.stringify(merged.metadata),
        merged.isArchived ? 1 : 0,
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM conversations WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  /** Touch the last_message_at timestamp for a conversation. */
  touchLastMessage(id: string): void {
    this.db
      .prepare(
        "UPDATE conversations SET last_message_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
      )
      .run(id);
  }

  /** Link a session to a conversation. */
  linkSession(sessionId: string, conversationId: string): void {
    this.db
      .prepare("UPDATE sessions SET conversation_id = ? WHERE id = ?")
      .run(conversationId, sessionId);
  }

  /** Get all sessions belonging to a conversation. */
  getSessions(conversationId: string): Session[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM sessions WHERE conversation_id = ? ORDER BY created_at DESC",
      )
      .all(conversationId) as any[];
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectPath: row.project_path,
      totalCost: row.total_cost,
      messageCount: row.message_count,
      isDaemon: !!row.is_daemon,
      tickCount: row.tick_count,
      lastTickAt: row.last_tick_at,
      isPaused: !!row.is_paused,
      tickIntervalMs: row.tick_interval_ms,
    }));
  }

  /** Fork a conversation — copies metadata but not sessions. */
  fork(id: string, newName?: string): Conversation | null {
    const original = this.get(id);
    if (!original) return null;
    return this.create(original.projectPath, {
      name: newName ?? `${original.name} (fork)`,
      description: original.description,
      tags: [...original.tags],
      modelOverride: original.modelOverride,
      memoryOverrides: { ...original.memoryOverrides },
      metadata: { ...original.metadata, forkedFrom: id },
    });
  }

  private mapRow(row: any): Conversation {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      projectPath: row.project_path,
      tags: JSON.parse(row.tags || "[]"),
      modelOverride: row.model_override,
      memoryOverrides: JSON.parse(row.memory_overrides || "{}"),
      metadata: JSON.parse(row.metadata || "{}"),
      isArchived: !!row.is_archived,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at,
    };
  }
}
