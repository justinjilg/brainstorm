import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_DIR = join(homedir(), ".brainstorm");
const DB_PATH = join(DB_DIR, "brainstorm.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  runMigrations(_db);
  cleanupOldRecords(_db);
  _db.pragma("optimize");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/** Delete cost records and model performance data older than 90 days. */
function cleanupOldRecords(db: Database.Database): void {
  const cutoff = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
  try {
    db.prepare("DELETE FROM cost_records WHERE timestamp < ?").run(cutoff);
    db.prepare("DELETE FROM model_performance WHERE timestamp < ?").run(cutoff);
    db.prepare("DELETE FROM model_performance_v2 WHERE timestamp < ?").run(
      cutoff,
    );
  } catch {
    // Tables may not exist yet on first run — safe to ignore
  }
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
    db
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((r: any) => r.name),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    try {
      db.exec("BEGIN");
      db.exec(migration.sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(
        migration.name,
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration "${migration.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

const MIGRATIONS = [
  {
    name: "001_sessions",
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
    name: "002_messages",
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
    name: "003_cost_records",
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
    name: "004_model_performance",
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
    name: "005_agent_profiles",
    sql: `
      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('architect', 'coder', 'reviewer', 'debugger', 'analyst', 'orchestrator', 'product-manager', 'security-reviewer', 'code-reviewer', 'style-reviewer', 'qa', 'compliance', 'devops', 'custom')),
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
    name: "006_workflow_definitions",
    sql: `
      CREATE TABLE workflow_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL,
        communication_mode TEXT NOT NULL DEFAULT 'handoff' CHECK (communication_mode IN ('handoff', 'shared', 'parallel')),
        max_iterations INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `,
  },
  {
    name: "007_workflow_runs",
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
    name: "008_workflow_step_runs",
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
    name: "009_model_performance_v2",
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
    name: "010_session_patterns",
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
    name: "011_session_checkpoints",
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
  {
    name: "012_session_locks",
    sql: `
      CREATE TABLE session_locks (
        session_id TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        acquired_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `,
  },
  {
    name: "013_message_timestamp_index",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_messages_session_ts
        ON messages(session_id, timestamp DESC);
    `,
  },
  {
    name: "014_audit_log",
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT,
        result_ok INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER,
        model_id TEXT,
        cost REAL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
    `,
  },
  {
    name: "015_code_embeddings",
    sql: `
      CREATE TABLE IF NOT EXISTS code_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        symbol_name TEXT,
        content_snippet TEXT NOT NULL,
        tfidf_vector TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_project ON code_embeddings(project_path);
      CREATE INDEX IF NOT EXISTS idx_embeddings_file ON code_embeddings(file_path);
    `,
  },
  {
    name: "016_projects",
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        custom_instructions TEXT,
        knowledge_files TEXT NOT NULL DEFAULT '[]',
        budget_daily REAL,
        budget_monthly REAL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
      CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
    `,
  },
  {
    name: "017_project_memory",
    sql: `
      CREATE TABLE IF NOT EXISTS project_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(project_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_project_memory_project ON project_memory(project_id);
    `,
  },
  {
    name: "018_sessions_project_id",
    sql: `
      ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
    `,
  },
  {
    name: "019_scheduled_tasks",
    sql: `
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cron_expression TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'trigger',
        allow_mutations INTEGER NOT NULL DEFAULT 0,
        budget_limit REAL,
        max_turns INTEGER NOT NULL DEFAULT 20,
        timeout_ms INTEGER NOT NULL DEFAULT 600000,
        model_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project ON scheduled_tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status);
    `,
  },
  {
    name: "020_scheduled_task_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id),
        status TEXT NOT NULL DEFAULT 'pending',
        trigger_type TEXT NOT NULL DEFAULT 'cron',
        output_summary TEXT,
        cost REAL NOT NULL DEFAULT 0,
        turns_used INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        trajectory_path TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_task ON scheduled_task_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_status ON scheduled_task_runs(status);
      CREATE INDEX IF NOT EXISTS idx_task_runs_created ON scheduled_task_runs(created_at);
    `,
  },
  {
    name: "021_orchestration",
    sql: `
      CREATE TABLE IF NOT EXISTS orchestration_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        lead_session_id TEXT REFERENCES sessions(id),
        status TEXT NOT NULL DEFAULT 'pending',
        project_ids TEXT NOT NULL DEFAULT '[]',
        budget_limit REAL,
        total_cost REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS orchestration_tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        subagent_type TEXT NOT NULL DEFAULT 'code',
        result_summary TEXT,
        cost REAL NOT NULL DEFAULT 0,
        session_id TEXT REFERENCES sessions(id),
        depends_on TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_orch_tasks_run ON orchestration_tasks(run_id);
    `,
  },
  {
    name: "022_plan_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS plan_runs (
        id TEXT PRIMARY KEY,
        plan_file_path TEXT NOT NULL,
        plan_name TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id),
        status TEXT NOT NULL DEFAULT 'pending',
        total_tasks INTEGER NOT NULL DEFAULT 0,
        completed_tasks INTEGER NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_plan_runs_project ON plan_runs(project_id);
      CREATE TABLE IF NOT EXISTS plan_task_runs (
        id TEXT PRIMARY KEY,
        plan_run_id TEXT NOT NULL REFERENCES plan_runs(id) ON DELETE CASCADE,
        task_path TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        assigned_skill TEXT,
        subagent_type TEXT,
        model_used TEXT,
        cost REAL NOT NULL DEFAULT 0,
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_plan_task_runs_plan ON plan_task_runs(plan_run_id);
      CREATE INDEX IF NOT EXISTS idx_plan_task_runs_status ON plan_task_runs(status);
    `,
  },
  {
    name: "023_routing_outcome_index",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_perf_v2_routing
        ON model_performance_v2(task_type, model_id, success);
    `,
  },
  {
    name: "024_compaction_commits",
    sql: `
      CREATE TABLE IF NOT EXISTS compaction_commits (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        summary TEXT NOT NULL,
        original_message_ids TEXT NOT NULL,
        kept_count INTEGER NOT NULL DEFAULT 0,
        summarized_count INTEGER NOT NULL DEFAULT 0,
        dropped_count INTEGER NOT NULL DEFAULT 0,
        tokens_before INTEGER,
        tokens_after INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_session ON compaction_commits(session_id);
    `,
  },
  {
    name: "025_daemon_sessions",
    sql: `
      ALTER TABLE sessions ADD COLUMN is_daemon INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN tick_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN last_tick_at INTEGER;
      ALTER TABLE sessions ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN tick_interval_ms INTEGER;

      CREATE TABLE IF NOT EXISTS daemon_daily_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        log_date TEXT NOT NULL,
        entry_time INTEGER NOT NULL DEFAULT (unixepoch()),
        tick_number INTEGER,
        event_type TEXT NOT NULL DEFAULT 'tick',
        content TEXT NOT NULL,
        cost REAL NOT NULL DEFAULT 0,
        model_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_daemon_log_date ON daemon_daily_log(log_date);
      CREATE INDEX IF NOT EXISTS idx_daemon_log_session ON daemon_daily_log(session_id);
    `,
  },
  {
    name: "026_godmode_changeset_log",
    sql: `
      CREATE TABLE IF NOT EXISTS godmode_changeset_log (
        changeset_id TEXT PRIMARY KEY,
        connector TEXT NOT NULL,
        action TEXT NOT NULL,
        description TEXT NOT NULL,
        risk_score INTEGER NOT NULL,
        status TEXT NOT NULL,
        changes_json TEXT,
        simulation_json TEXT,
        rollback_json TEXT,
        created_at INTEGER NOT NULL,
        executed_at INTEGER,
        session_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_gm_changeset_connector ON godmode_changeset_log(connector);
      CREATE INDEX IF NOT EXISTS idx_gm_changeset_status ON godmode_changeset_log(status);
      CREATE INDEX IF NOT EXISTS idx_gm_changeset_created ON godmode_changeset_log(created_at);
    `,
  },
  {
    name: "027_widen_role_and_comm_constraints",
    sql: `
      -- SQLite cannot ALTER CHECK constraints, so we drop and recreate.
      -- agent_profiles: widen role to include all AgentRole values
      CREATE TABLE IF NOT EXISTS agent_profiles_new (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
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
      INSERT OR IGNORE INTO agent_profiles_new SELECT * FROM agent_profiles;
      DROP TABLE IF EXISTS agent_profiles;
      ALTER TABLE agent_profiles_new RENAME TO agent_profiles;

      -- workflow_definitions: widen communication_mode to include 'parallel'
      CREATE TABLE IF NOT EXISTS workflow_definitions_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL,
        communication_mode TEXT NOT NULL DEFAULT 'handoff',
        max_iterations INTEGER NOT NULL DEFAULT 3,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT OR IGNORE INTO workflow_definitions_new SELECT * FROM workflow_definitions;
      DROP TABLE IF EXISTS workflow_definitions;
      ALTER TABLE workflow_definitions_new RENAME TO workflow_definitions;
    `,
  },
  {
    name: "028_conversations",
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Untitled',
        description TEXT NOT NULL DEFAULT '',
        project_path TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        model_override TEXT,
        memory_overrides TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}',
        is_archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_message_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_path);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

      ALTER TABLE sessions ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions(conversation_id);
    `,
  },
  {
    name: "029_orchestration_workers",
    sql: `
      ALTER TABLE orchestration_tasks ADD COLUMN assigned_worker TEXT;
      ALTER TABLE orchestration_tasks ADD COLUMN worktree_path TEXT;
      ALTER TABLE orchestration_tasks ADD COLUMN files_touched TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE orchestration_tasks ADD COLUMN error TEXT;
      CREATE INDEX IF NOT EXISTS idx_orch_tasks_status ON orchestration_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_orch_tasks_worker ON orchestration_tasks(assigned_worker);
    `,
  },
];
