# Tools Reference

Brainstorm ships with 42 built-in tools. All tools use Zod schemas for input validation and return a normalized `{ ok, data?, error? }` format.

## Tool Categories

### Filesystem (8)

| Tool | Description | Permission |
|------|------------|------------|
| `file_read` | Read a file by path | auto |
| `file_write` | Write content to a file (creates or overwrites) | confirm |
| `file_edit` | Find-and-replace in a file | confirm |
| `multi_edit` | Multiple find-and-replace edits in one file | confirm |
| `batch_edit` | Edits across multiple files in one call | confirm |
| `list_dir` | List directory contents | auto |
| `glob` | Find files by glob pattern | auto |
| `grep` | Search file contents by regex | auto |

### Shell (3)

| Tool | Description | Permission |
|------|------------|------------|
| `shell` | Execute a shell command (foreground or background) | confirm |
| `process_spawn` | Spawn a long-running background process | confirm |
| `process_kill` | Kill a background process by PID | confirm |

### Git (6)

| Tool | Description | Permission |
|------|------------|------------|
| `git_status` | Show working tree status | auto |
| `git_diff` | Show diffs (staged, unstaged, or between refs) | auto |
| `git_log` | Show commit history | auto |
| `git_commit` | Create a commit with message | confirm |
| `git_branch` | Create, switch, or delete branches | confirm |
| `git_stash` | Stash or restore changes | confirm |

### GitHub (2)

| Tool | Description | Permission |
|------|------------|------------|
| `gh_pr` | Create, list, or view pull requests | confirm |
| `gh_issue` | Create, list, or view issues | confirm |

### Web (2)

| Tool | Description | Permission |
|------|------------|------------|
| `web_fetch` | Fetch a URL and return content | confirm |
| `web_search` | Search the web via DuckDuckGo | confirm |

### Tasks (3)

| Tool | Description | Permission |
|------|------------|------------|
| `task_create` | Create a progress-tracking task | auto |
| `task_update` | Update task status (pending/in_progress/done/failed) | auto |
| `task_list` | List current tasks | auto |

### Agent (6)

| Tool | Description | Permission |
|------|------------|------------|
| `undo_last_write` | Revert the last file write using checkpoint | confirm |
| `scratchpad_write` | Save a compaction-resistant note | auto |
| `scratchpad_read` | Read scratchpad entries | auto |
| `ask_user` | Pause and ask the user a question | auto |
| `set_routing_hint` | Hint the router for next turn (cheap/quality/fast) | auto |
| `cost_estimate` | Show estimated costs across model tiers | auto |

### Planning (1)

| Tool | Description | Permission |
|------|------------|------------|
| `plan_preview` | Show a multi-step plan for user approval | auto |

### Transactions (3)

| Tool | Description | Permission |
|------|------------|------------|
| `begin_transaction` | Start an atomic multi-file edit session | auto |
| `commit_transaction` | Finalize all tracked writes | auto |
| `rollback_transaction` | Revert all writes since begin | confirm |

### BrainstormRouter Intelligence (8)

| Tool | Description | Permission |
|------|------------|------------|
| `br_status` | Full system check (identity, budget, health) | auto |
| `br_budget` | Budget status and spend forecast | auto |
| `br_leaderboard` | Real model performance rankings | auto |
| `br_insights` | Cost optimization recommendations | auto |
| `br_models` | Available models with pricing | auto |
| `br_memory_search` | Search persistent memory across sessions | auto |
| `br_memory_store` | Save facts that persist across sessions | auto |
| `br_health` | Quick connectivity test | auto |

## Permission Levels

- **auto** — Runs without asking. Used for read-only tools and agent-internal state.
- **confirm** — Asks the user before executing. Used for writes, shell commands, and destructive operations.
- **deny** — Blocked. Can be set per-tool in config.

Permission mode is set globally: `strict` (confirm everything), `normal` (default), `permissive` (auto-approve most).

## Adding Custom Tools

1. Create a new file in `packages/tools/src/builtin/`:

```typescript
import { z } from 'zod';
import { defineTool } from '../base.js';

export const myTool = defineTool({
  name: 'my_tool',
  description: 'What this tool does',
  permission: 'confirm',  // 'auto' | 'confirm' | 'deny'
  inputSchema: z.object({
    param: z.string().describe('Parameter description'),
  }),
  async execute({ param }) {
    // Implementation
    return { ok: true, data: { result: 'done' } };
  },
});
```

2. Register in `packages/tools/src/index.ts`:

```typescript
import { myTool } from './builtin/my-tool.js';

// In createDefaultToolRegistry():
registry.register(myTool);
```

3. Export the tool:

```typescript
export { myTool } from './builtin/my-tool.js';
```

## Checkpoint System

Every file write/edit automatically snapshots the original file before modifying it. The `undo_last_write` tool can revert to the last checkpoint for any file.

Checkpoints are session-scoped and stored in a temp directory. They are cleaned up when the session ends.

## Transaction System

For atomic multi-file changes:

```
begin_transaction → file_write × N → commit_transaction
                                    → rollback_transaction (reverts all)
```

Between `begin` and `commit/rollback`, all file writes are tracked. On rollback, files are reverted in reverse order using the checkpoint system.

## Pre-Validation

Before writing `.ts`, `.tsx`, `.json`, or `.yaml` files, Brainstorm runs a quick syntax check:
- **TypeScript/JavaScript:** Bracket/brace balance check
- **JSON:** `JSON.parse()` validation
- **YAML:** Basic structural validation

Pre-validation warnings are non-blocking — the write still happens, but the agent sees the warning.

## Tool Health Tracking

Every tool call's success/failure is recorded. A tool is marked "unhealthy" when it has 2+ failures and >50% failure rate. Unhealthy tools are surfaced in the turn context so the agent avoids retrying broken tools.
