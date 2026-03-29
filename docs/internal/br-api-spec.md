# BrainstormRouter API Spec for Brainstorm CLI Integration

## Context

Brainstorm CLI now has Projects, Scheduled Tasks, Orchestration, and Letta-inspired agent memory. Most of these work locally (SQLite + files). This spec defines the BR endpoints needed for cloud sync, cross-device continuity, and intelligent features.

## What Already Exists in BR (No Changes Needed)

These BR endpoints are already implemented and Brainstorm can call them today:

| Endpoint                        | BR File                     | Brainstorm Usage        |
| ------------------------------- | --------------------------- | ----------------------- |
| `POST /v1/chat/completions`     | core routing                | LLM proxy — working     |
| `GET /v1/memory/entries`        | `routes/memory.ts`          | List all memories       |
| `POST /v1/memory/entries`       | `routes/memory.ts`          | Store memory entry      |
| `POST /v1/memory/query`         | `routes/memory.ts`          | Semantic search         |
| `PUT /v1/memory/entries/:id`    | `routes/memory.ts`          | Update memory           |
| `DELETE /v1/memory/entries/:id` | `routes/memory.ts`          | Delete memory           |
| `GET /v1/intelligence/rankings` | `routes/intelligence.ts`    | Model leaderboard       |
| `POST /v1/intelligence/advise`  | `routes/intelligence.ts`    | Routing recommendations |
| `POST /v1/agent/bootstrap`      | `routes/agent-bootstrap.ts` | Agent identity          |
| `GET /v1/agent/status`          | `routes/agent-bootstrap.ts` | Agent self-awareness    |

**Action**: Verify these work with Brainstorm's current gateway client. The memory endpoints are the most important — they back the agent's `br_memory_search` and `br_memory_store` tools.

---

## New Endpoints Needed

### 1. Project-Scoped Memory

**Problem**: Current memory is tenant-global. Brainstorm now has per-project memory. When the agent saves a memory about HawkTalk's database driver, it shouldn't pollute the Brainstorm CLI project's context.

**Solution**: Add optional `project` parameter to existing memory endpoints.

#### `POST /v1/memory/entries` (Modification)

Add optional `project` field to request body:

```typescript
// Current
{ block: "semantic", content: "Uses Drizzle ORM" }

// Enhanced
{ block: "semantic", content: "Uses Drizzle ORM", project: "hawktalk" }
```

When `project` is provided:

- Entry is tagged with project scope
- `/v1/memory/query` with `project` filter only searches that project's entries
- `/v1/memory/entries?project=hawktalk` returns project-scoped entries

#### `POST /v1/memory/query` (Modification)

Add optional `project` filter:

```typescript
// Current
{ query: "database driver" }

// Enhanced
{ query: "database driver", project: "hawktalk" }
```

**DB Schema Change**: Add `project_slug TEXT` column to `memory_entries` table (nullable, for backward compat).

**Effort**: Small — add column, filter in queries. No new routes needed.

---

### 2. Project Registry Sync

**Problem**: Brainstorm registers 18+ projects locally. If the user works from a different machine, those registrations are lost. BR should be the source of truth for project metadata.

#### `GET /v1/projects`

Returns all registered projects for the tenant.

```json
{
  "projects": [
    {
      "id": "uuid",
      "name": "hawktalk",
      "path": "/home/user/projects/my-app",
      "description": "AI-powered book club app",
      "budget_daily": 5.0,
      "budget_monthly": 50.0,
      "created_at": "2026-03-28T15:00:00Z"
    }
  ]
}
```

#### `POST /v1/projects`

Register or sync a project.

```json
{
  "name": "hawktalk",
  "path": "/home/user/projects/my-app",
  "description": "AI-powered book club app",
  "budget_daily": 5.0,
  "budget_monthly": 50.0
}
```

Returns: the created/updated project with server-assigned ID.

#### `GET /v1/projects/:name/memory`

Get all memory entries for a specific project.

```json
{
  "entries": [
    {
      "key": "auth-pattern",
      "value": "Supabase for auth, DO PostgreSQL for data",
      "category": "convention",
      "updated_at": "2026-03-28T16:00:00Z"
    }
  ]
}
```

#### `POST /v1/projects/:name/memory`

Sync a memory entry for a project (upsert by key).

```json
{
  "key": "auth-pattern",
  "value": "Supabase for auth, DO PostgreSQL for data",
  "category": "convention"
}
```

**DB Schema**: New `projects` table in BR PostgreSQL:

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  path TEXT,
  description TEXT DEFAULT '',
  budget_daily NUMERIC(10,4),
  budget_monthly NUMERIC(10,4),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, name)
);
```

**Effort**: Medium — new table, 4 new routes, SDK updates.

---

### 3. Scheduled Task Telemetry

**Problem**: Scheduled tasks run locally. BR has no visibility into what's running, success rates, or costs. This data is valuable for the dashboard and for improving routing.

#### `POST /v1/agent/task-runs`

Report a completed task run (fire-and-forget from Brainstorm after each run).

```json
{
  "task_name": "run typecheck",
  "project": "brainstorm",
  "status": "completed",
  "trigger_type": "cron",
  "cost": 0.0042,
  "turns_used": 3,
  "duration_ms": 12500,
  "model_used": "claude-sonnet-4.6",
  "cron_expression": "0 9 * * *",
  "allow_mutations": false,
  "timestamp": "2026-03-28T09:00:12Z"
}
```

**Use cases for BR**:

- Show scheduled task history in BR dashboard
- Track cost trends per project
- Alert if a scheduled task starts failing repeatedly
- Feed into routing intelligence (which models work for automated tasks?)

**DB Schema**: New `task_run_reports` table:

```sql
CREATE TABLE task_run_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  task_name TEXT NOT NULL,
  project_slug TEXT,
  status TEXT NOT NULL,
  trigger_type TEXT,
  cost NUMERIC(10,6),
  turns_used INTEGER,
  duration_ms INTEGER,
  model_used TEXT,
  cron_expression TEXT,
  allow_mutations BOOLEAN,
  reported_at TIMESTAMPTZ DEFAULT now()
);
```

#### `GET /v1/agent/task-runs?project=brainstorm&limit=20`

Query task run history (for BR dashboard or cross-device sync).

**Effort**: Small — 2 routes, 1 table, no complex logic.

---

### 4. Orchestration Coordination (Future)

**Problem**: Orchestration currently runs locally. For true multi-device orchestration (e.g., start from laptop, continue from desktop), BR needs to coordinate.

This is **not needed now** — local orchestration works. But the API shape would be:

#### `POST /v1/orchestration/runs`

Create a cross-project orchestration run.

#### `GET /v1/orchestration/runs/:id`

Get run status with per-project task breakdown.

#### `POST /v1/orchestration/runs/:id/tasks/:taskId/result`

Report a task completion from a subagent.

**Effort**: Medium-large. Defer until local orchestration is proven.

---

### 5. Core Memory Blocks API (Letta-style)

**Problem**: Brainstorm's agent now has structured core memory (decisions, conventions, warnings). BR should serve as the cloud backup and cross-device sync layer for these blocks.

#### `GET /v1/memory/blocks`

Already exists in BR — returns block names with entry counts.

**Enhancement needed**: Support `project` filter:

```
GET /v1/memory/blocks?project=hawktalk
```

Returns blocks scoped to that project's memories.

#### `POST /v1/memory/blocks/sync`

Bulk sync core memory blocks from Brainstorm to BR.

```json
{
  "project": "brainstorm",
  "blocks": {
    "conventions": [
      { "key": "import-style", "value": ".js extensions for ESM" },
      { "key": "build-tool", "value": "tsup for all packages" }
    ],
    "decisions": [
      { "key": "db-driver", "value": "postgres.js over pg for ESM compat" }
    ],
    "warnings": [
      { "key": "shell-DATABASE_URL", "value": "Shell has stale BSM URL" }
    ]
  }
}
```

This is a bulk upsert — Brainstorm calls it on session end to sync local state to cloud.

**Effort**: Small — wraps existing memory CRUD in a batch operation.

---

## Priority Order

| Priority | Endpoint                                | Effort | Impact                         |
| -------- | --------------------------------------- | ------ | ------------------------------ |
| **P0**   | Verify existing memory endpoints work   | None   | Unblocks agent memory tools    |
| **P1**   | Add `project` param to memory endpoints | Small  | Project-scoped memory          |
| **P2**   | `POST /v1/agent/task-runs`              | Small  | Scheduled task telemetry       |
| **P3**   | Project registry sync (`/v1/projects`)  | Medium | Cross-device project awareness |
| **P4**   | `POST /v1/memory/blocks/sync`           | Small  | Bulk core memory sync          |
| **P5**   | Orchestration coordination              | Large  | Defer                          |

## Integration Points in Brainstorm

| Brainstorm Component        | BR Endpoint                   | When Called                |
| --------------------------- | ----------------------------- | -------------------------- |
| `memory_save` tool          | `POST /v1/memory/entries`     | Agent explicitly saves     |
| `memory_search` tool        | `POST /v1/memory/query`       | Agent searches recall      |
| `MemoryManager.save()`      | `POST /v1/memory/entries`     | Auto-extraction middleware |
| `TriggerRunner.complete()`  | `POST /v1/agent/task-runs`    | After each scheduled run   |
| `ProjectManager.register()` | `POST /v1/projects`           | On project registration    |
| Session end hook            | `POST /v1/memory/blocks/sync` | Sync core memory to cloud  |

## Lockstep Requirements (per BR CLAUDE.md)

Every new route in BR requires same-commit updates to:

1. TypeScript SDK (`packages/sdk-ts/`)
2. Python SDK (`packages/sdk-py/`)
3. MCP tools (`src/mcp/server.ts`)
4. Ship log entry (`docs/ship-log/`)
