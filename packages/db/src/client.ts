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
];
