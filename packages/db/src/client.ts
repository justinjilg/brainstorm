import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DB_DIR = join(homedir(), '.brainstorm');
const DB_PATH = join(DB_DIR, 'brainstorm.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  runMigrations(_db);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    db.exec(migration.sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name);
  }
}

const MIGRATIONS = [
  {
    name: '001_sessions',
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        project_path TEXT NOT NULL,
        total_cost REAL NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    name: '002_messages',
    sql: `
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL,
        model_id TEXT,
        token_count INTEGER,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_messages_session ON messages(session_id);
    `,
  },
  {
    name: '003_cost_records',
    sql: `
      CREATE TABLE cost_records (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL,
        task_type TEXT NOT NULL,
        project_path TEXT
      );
      CREATE INDEX idx_cost_session ON cost_records(session_id);
      CREATE INDEX idx_cost_timestamp ON cost_records(timestamp);
    `,
  },
  {
    name: '004_model_performance',
    sql: `
      CREATE TABLE model_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        latency_ms INTEGER,
        user_accepted INTEGER,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_perf_model ON model_performance(model_id);
    `,
  },
  {
    name: '005_agent_profiles',
    sql: `
      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('architect', 'coder', 'reviewer', 'debugger', 'analyst', 'custom')),
        description TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL,
        system_prompt TEXT,
        allowed_tools TEXT NOT NULL DEFAULT '"all"',
        output_format TEXT,
        budget_per_workflow REAL,
        budget_daily REAL,
        exhaustion_action TEXT NOT NULL DEFAULT 'downgrade',
        downgrade_model_id TEXT,
        confidence_threshold REAL NOT NULL DEFAULT 0.7,
        max_steps INTEGER NOT NULL DEFAULT 10,
        fallback_chain TEXT NOT NULL DEFAULT '[]',
        guardrails TEXT NOT NULL DEFAULT '{}',
        lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'suspended')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `,
  },
  {
    name: '006_workflow_definitions',
    sql: `
      CREATE TABLE workflow_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL,
        communication_mode TEXT NOT NULL DEFAULT 'handoff' CHECK (communication_mode IN ('handoff', 'shared')),
        max_iterations INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `,
  },
  {
    name: '007_workflow_runs',
    sql: `
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id),
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
        total_cost REAL NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        iteration INTEGER NOT NULL DEFAULT 0,
        max_iterations INTEGER NOT NULL DEFAULT 3,
        communication_mode TEXT NOT NULL DEFAULT 'handoff',
        continue_from_run_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
    `,
  },
  {
    name: '008_workflow_step_runs',
    sql: `
      CREATE TABLE workflow_step_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        step_def_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        artifact_json TEXT,
        error TEXT,
        cost REAL NOT NULL DEFAULT 0,
        iteration INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER
      );
      CREATE INDEX idx_step_runs_run ON workflow_step_runs(run_id);
    `,
  },
  {
    name: '010_session_patterns',
    sql: `
      CREATE TABLE session_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        pattern_type TEXT NOT NULL CHECK (pattern_type IN ('tool_success', 'command_timing', 'user_preference', 'model_choice')),
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        occurrences INTEGER NOT NULL DEFAULT 1,
        last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_patterns_project ON session_patterns(project_path);
      CREATE INDEX idx_patterns_type ON session_patterns(pattern_type, key);
      CREATE UNIQUE INDEX idx_patterns_unique ON session_patterns(project_path, pattern_type, key);
    `,
  },
  {
    name: '009_model_performance_v2',
    sql: `
      CREATE TABLE model_performance_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        shape_key TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        latency_ms INTEGER,
        cost_usd REAL,
        validity_score REAL,
        quality_score REAL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        user_accepted INTEGER,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_perf_v2_model_task ON model_performance_v2(model_id, task_type);
      CREATE INDEX idx_perf_v2_shape ON model_performance_v2(shape_key);
      CREATE INDEX idx_perf_v2_timestamp ON model_performance_v2(timestamp);
    `,
  },
  {
    name: '011_session_checkpoints',
    sql: `
      CREATE TABLE session_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX idx_checkpoint_session ON session_checkpoints(session_id);
      CREATE INDEX idx_checkpoint_created ON session_checkpoints(created_at);
    `,
  },
];
