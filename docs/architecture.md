# Architecture

Brainstorm is a Turborepo monorepo with 27 TypeScript packages. All packages use ESM (`"type": "module"`) with tsup bundling and `.js` import extensions.

## Package Dependency Graph

```
                         ┌──────────┐
                         │  shared   │  Types, errors, logger (pino)
                         └────┬─────┘
                              │
              ┌───────┬───────┼───────┬───────┐
              ▼       ▼       ▼       ▼       ▼
         ┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐
         │ config ││   db   ││  eval  ││  sdk   ││ docgen │
         └───┬────┘└───┬────┘└────────┘└────────┘└────────┘
             │         │
         ┌───┴─────────┤
         ▼             ▼
    ┌───────────┐  ┌────────┐
    │ providers │  │ vault  │
    └─────┬─────┘  └────────┘
          │
     ┌────┴────┐
     ▼         ▼
┌────────┐ ┌─────────┐
│ router │ │ gateway │
└───┬────┘ └─────────┘
    │
    ▼
┌────────┐   ┌────────┐   ┌────────┐   ┌────────────┐
│ tools  │──▶│  core  │──▶│  hooks │   │ code-graph │
└────────┘   └───┬────┘   └────────┘   └────────────┘
                 │
      ┌──────────┼──────────┬──────────┐
      ▼          ▼          ▼          ▼
 ┌────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐
 │ agents │ │ workflow │ │  mcp   │ │ godmode │
 └────────┘ └──────────┘ └────────┘ └─────────┘
                 │
      ┌──────────┼──────────┬──────────┬──────────┐
      ▼          ▼          ▼          ▼          ▼
 ┌────────┐ ┌───────────┐ ┌───────┐ ┌─────────┐ ┌────────┐
 │  cli   │ │plugin-sdk │ │server │ │ onboard │ │ ingest │
 └────────┘ └───────────┘ └───────┘ └─────────┘ └────────┘
                 │
      ┌──────────┼──────────┬──────────┐
      ▼          ▼          ▼          ▼
 ┌──────────┐ ┌───────────┐ ┌────────┐ ┌──────────┐
 │ projects │ │ scheduler │ │ vscode │ │orchestr. │
 └──────────┘ └───────────┘ └────────┘ └──────────┘
```

## Data Flow

### Chat Request

```
User prompt
  → CLI (Commander + Ink TUI)
    → Core agent loop (streamText, AI SDK v6)
      → Router (classify task → pick strategy → select model)
        → Provider (AI Gateway / BrainstormRouter / Ollama)
          → LLM API
        ← Response stream (text-delta, tool-call, tool-result)
      ← Tool execution (permission check → execute → normalize)
    ← Agent events (text, tool-call, tool-result, compaction-warning)
  → TUI rendering (streaming text, tool status, progress)
```

### Routing Decision

```
User prompt
  → classifyTask(prompt)
    → Returns: TaskProfile { complexity, category, needsCode, ... }
  → Strategy selection (quality-first | cost-first | combined | capability | rule-based)
    → Strategy scores all available models
    → CostTracker checks budget
    → Fallback chain if primary model fails
  → Returns: { model, strategy, reasoning }
```

### Tool Execution

```
Model calls tool
  → Permission check (auto | confirm | deny)
    → If confirm: ask user
  → Pre-validation (syntax check for .ts, .json, .yaml)
  → Checkpoint snapshot (before file writes)
  → Execute tool
  → Post-execution: diff preview, lint check, build state update
  → Normalize result to { ok, data?, error? }
  → Record in file tracker + tool health tracker
```

## Package Details

### `packages/shared`

Foundation types shared across all packages.

**Key exports:**

- `TaskProfile` — Describes a classified task (complexity, category, tokens)
- `ModelEntry` — A model with pricing, capabilities, provider info
- `AgentProfile` — Configuration for a specialized agent
- `TurnContext` — Per-turn state (model, tools, cost, files, build status)
- `AgentEvent` — Union type for all events the agent loop yields
- `formatTurnContext()` — Compact one-liner for context injection

### `packages/config`

Layered configuration with Zod validation.

**Config resolution order:** defaults → `~/.brainstorm/config.toml` (global) → `./brainstorm.toml` (project) → environment variables.

**Key exports:**

- `loadConfig()` — Merges all config layers
- `loadProjectContext()` — Parses `BRAINSTORM.md` frontmatter + body
- `brainstormConfigSchema` — Zod schema for full config validation

### `packages/db`

SQLite persistence with WAL mode. Database lives at `~/.brainstorm/brainstorm.db`.

**Tables:** sessions, messages, cost_records, agent_profiles, workflow_runs, eval_results, session_patterns.

**Key exports:**

- `getDatabase()` — Singleton database connection with auto-migrations
- `PatternRepository` — Cross-session learning storage (UPSERT with confidence decay)

### `packages/providers`

Model discovery and AI SDK provider creation.

**Cloud:** BrainstormRouter (357+ models via `api.brainstormrouter.com/v1`), direct Anthropic/OpenAI/Google.
**Local:** Ollama (`:11434`), LM Studio (`:1234`), llama.cpp (`:8080`) — auto-discovered by probing localhost.

**Key exports:**

- `ProviderRegistry` — Manages all providers, creates AI SDK language models
- `discoverLocalModels()` — Probes local endpoints with caching

### `packages/router`

Task classification and model routing.

**Strategies:**
| Strategy | Description |
|----------|------------|
| `quality-first` | Best model for the task (default with paid keys) |
| `cost-first` | Cheapest viable model |
| `combined` | Balances quality, cost, and speed |
| `capability` | Routes by measured eval scores |
| `rule-based` | Custom rules from config.toml |

**Key exports:**

- `BrainstormRouter` — Main router with `route(prompt, options)` method
- `classifyTask()` — Heuristic classifier returning `TaskProfile`
- `CostTracker` — Per-session and daily cost tracking

### `packages/tools`

58+ built-in tools with Zod input schemas and consistent `{ ok, data, error }` output.

**Categories:**

- Filesystem (8): file_read, file_write, file_edit, multi_edit, batch_edit, list_dir, glob, grep
- Shell (3): shell, process_spawn, process_kill
- Git (6): git_status, git_diff, git_log, git_commit, git_branch, git_stash
- GitHub (8): gh_pr, gh_issue, gh_search, gh_actions, gh_release, gh_review, gh_checks, gh_repos
- Web (2): web_fetch, web_search
- Tasks (3): task_create, task_update, task_list
- Agent (6): undo, scratchpad_write, scratchpad_read, ask_user, set_routing_hint, cost_estimate
- Planning (1): plan_preview
- Transactions (3): begin_transaction, commit_transaction, rollback_transaction
- BrainstormRouter (8): br_status, br_budget, br_leaderboard, br_insights, br_models, br_memory_search, br_memory_store, br_health

**Key systems:**

- `ToolRegistry` — Registers tools, wraps with permission checks
- `CheckpointManager` — Snapshots files before writes for undo support
- `SessionFileTracker` — Tracks all file reads/writes per session
- `ToolHealthTracker` — Records success/failure per tool, marks unhealthy tools

### `packages/core`

The brain — agent loop, session management, and intelligence features.

**Key exports:**

- `runAgentLoop()` — Main agent loop using AI SDK v6 `streamText`
- `SessionManager` — Conversation history and turn tracking
- `PermissionManager` — Three modes: strict, normal, permissive
- `compactContext()` — Context window management with scratchpad preservation
- `BuildStateTracker` — Tracks build/test results, injects warnings
- `LoopDetector` — Detects repetitive tool call patterns
- `SessionPatternLearner` — Cross-session learning from tool usage patterns
- `FileWatcher` — Detects external file changes between turns
- `ReactionTracker` — Classifies user satisfaction from messages

### `packages/agents`

Agent profiles and the subagent system.

**9 subagent types:** explore, plan, code, review, general, decompose, external, research, memory-curator — each with filtered tool sets and role-specific prompts. Supports parallel execution via `spawnParallel()`.

**14 agent roles:** architect, coder, reviewer, debugger, analyst, orchestrator, product-manager, security-reviewer, code-reviewer, style-reviewer, qa, compliance, devops, custom.

### `packages/workflow`

State machine workflow engine with 4 preset workflows and context filtering.

### `packages/hooks`

Lifecycle automation with 10 event types: PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit, PreCompact, Notification, SubagentStart, SubagentStop, PostShell.

Built-in hooks include auto-lint on file writes.

### `packages/mcp`

MCP (Model Context Protocol) client for external tool integration via SSE/HTTP transports.

### `packages/eval`

Capability probes, eval runner, scorer, and scorecard for measuring model performance. Results feed back into the capability routing strategy.

### `packages/gateway`

Typed client for the BrainstormRouter SaaS API. Handles header parsing, cost reconciliation, and retry logic.

### `packages/vault`

Encrypted key storage using AES-256-GCM + Argon2id. Supports 1Password bridge for enterprise environments. Fallback to environment variables.

### `packages/cli`

Commander-based CLI with Ink TUI. Entry point: `packages/cli/src/bin/brainstorm.ts`.

**Commands:** `chat` (default), `run`, `models`, `config`, `budget`, `agent`, `workflow`, `sessions`, `vault`, `eval`.

## Intelligence Features

Brainstorm includes several features that make the agent self-aware:

| Feature                    | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| **Turn Context**           | Injected between turns: model, tools, cost, files, build status |
| **File Tracking**          | Agent knows every file it has read/written this session         |
| **Tool Health**            | Unhealthy tools surfaced in context so agent avoids them        |
| **Build State**            | Persistent warning when build is broken                         |
| **Loop Detection**         | Nudges agent out of repetitive read patterns                    |
| **Scratchpad**             | Key-value notes that survive context compaction                 |
| **Sentiment**              | Adapts response style based on detected user tone               |
| **Self-Review**            | Optional cheap-model review of writes before finalizing         |
| **Cross-Session Learning** | Learns tool preferences and command timings per project         |
| **Error-Fix Pairs**        | Tracks error → fix sequences for future reference               |
| **Speculative Execution**  | Tries two approaches in parallel git worktrees                  |
