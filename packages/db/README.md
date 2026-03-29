# @brainst0rm/db

SQLite persistence layer using better-sqlite3 with WAL mode. Database at `~/.brainstorm/brainstorm.db`.

## Key Exports

- `getDatabase()` — Singleton database connection with auto-migrations
- `PatternRepository` — Cross-session learning storage with UPSERT and confidence decay

## Tables

sessions, messages, cost_records, agent_profiles, workflow_runs, eval_results, session_patterns

## Usage

```typescript
import { getDatabase, PatternRepository } from "@brainst0rm/db";

const db = getDatabase();
const patterns = new PatternRepository(db);
patterns.record("/path", "tool_success", "file_edit", "jsx files", 0.8);
```
