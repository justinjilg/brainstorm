# Brainstorm CLI Feature Reference

Complete reference for every feature in the Brainstorm CLI assistant. This document covers all tools, commands, agents, strategies, middleware, hooks, configuration, and architecture.

---

## Table of Contents

1. [Tools](#1-tools)
2. [Slash Commands](#2-slash-commands)
3. [Roles](#3-roles)
4. [Routing Strategies](#4-routing-strategies)
5. [Agent Types](#5-agent-types)
6. [Middleware Pipeline](#6-middleware-pipeline)
7. [Hook Points](#7-hook-points)
8. [TUI Modes](#8-tui-modes)
9. [Workflow Presets](#9-workflow-presets)
10. [Configuration](#10-configuration)
11. [Database Schema](#11-database-schema)
12. [MCP Integration](#12-mcp-integration)
13. [Vault](#13-vault)
14. [Plugin SDK](#14-plugin-sdk)
15. [Orchestration Pipeline](#15-orchestration-pipeline)
16. [Intelligence](#16-intelligence)

---

## 1. Tools

42+ built-in tools grouped by category. Each tool has a permission level:

- **auto** -- runs without user confirmation
- **confirm** -- requires user approval before execution

### Filesystem (8 tools)

| Tool         | Permission | Description                                                                                                                                                                                                                                           |
| ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file_read`  | auto       | Read file contents. Supports `limit` and `offset` for large files. Blocks system paths (`/etc`, `/usr`, `/var`, `/proc`, `/sys`, `/dev`). Caches reads for performance. Returns `{ content, totalLines }`.                                            |
| `file_write` | confirm    | Write content to a file, creating it and parent directories as needed. Atomic writes (write to temp, then rename). Snapshots existing file for undo. Pre-validates content. Tracks in active transactions. Returns `{ success, path, bytesWritten }`. |
| `file_edit`  | confirm    | Surgical string replacement. `old_string` must match exactly one location. On zero matches, suggests closest match with context. On multiple matches, requests more context. Snapshots for undo. Returns diff preview.                                |
| `multi_edit` | confirm    | Multiple find-and-replace edits in a single file atomically. Takes an array of `{ old_string, new_string }` operations. Applies all or reports partial results.                                                                                       |
| `batch_edit` | confirm    | Cross-file find-and-replace in one operation. Each file gets its own edit list. Two-phase execution: validate all edits, then apply. Partial success supported.                                                                                       |
| `glob`       | auto       | Find files matching a glob pattern (e.g., `**/*.ts`). Uses `fast-glob`. Ignores `node_modules`, `dist`, `.git`. Returns files sorted by modification time.                                                                                            |
| `grep`       | auto       | Search file contents using ripgrep (regex). Returns matching lines in `file:line` format. Supports glob filtering and max results (default: 50). Falls back gracefully if `rg` not installed.                                                         |
| `list_dir`   | auto       | List directory contents with file sizes and types. Optional recursive mode. Skips hidden files, `node_modules`, `dist`. Truncates at 200 entries.                                                                                                     |

### Shell (3 tools)

| Tool            | Permission | Description                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`         | confirm    | Execute a shell command via `/bin/sh -c`. Supports foreground (default 120s timeout) and background mode (returns task ID, notifies on completion). Output truncated with head+tail strategy (first 20KB + last 20KB). Sandbox enforcement blocks dangerous commands. Git safety layer blocks destructive git ops. Docker container mode available. |
| `process_spawn` | confirm    | Start a long-running background process (dev server, watcher). Detached from parent. Tracked by name for management. Max 100 managed processes.                                                                                                                                                                                                     |
| `process_kill`  | confirm    | Kill a managed background process by name. Sends SIGTERM.                                                                                                                                                                                                                                                                                           |

### Git (7 tools)

| Tool         | Permission | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_status` | auto       | Show working tree status (modified, staged, untracked files) in short format.                                                                                                                                                                                                                                                                                                                                                                                       |
| `git_diff`   | auto       | Show changes between commits, working tree, or staging area. Supports `--cached` for staged changes. Truncates at 15KB.                                                                                                                                                                                                                                                                                                                                             |
| `git_log`    | auto       | Show recent commit history in oneline format. Default: 20 commits. Optional file filter.                                                                                                                                                                                                                                                                                                                                                                            |
| `git_commit` | confirm    | Smart two-mode commit tool. **Analyze mode** (no message): stages files, scans for credentials, returns context (status, diff, recent commits) for generating a message. **Commit mode** (with message): stages, scans, commits. Always requires explicit file paths (never `git add -A`). Scans for 7 credential patterns (AWS keys, GitHub tokens, OpenAI/Anthropic keys, Stripe keys, PEM keys, BR API keys, generic secrets). Supports Co-Authored-By trailers. |
| `git_branch` | confirm    | Create, switch, delete, or list branches. Protects main/master/production/release from deletion. Warns about uncommitted changes before switching. Safe delete only (fully merged branches).                                                                                                                                                                                                                                                                        |
| `git_stash`  | confirm    | Push, pop, apply, list, or drop git stashes. Supports messages for push. Index-based access for pop/apply/drop.                                                                                                                                                                                                                                                                                                                                                     |
| `git_safety` | (internal) | Guards against destructive git operations: no force-push to protected branches, no `--no-verify`, no `--amend` preference, no `git add -A`, credential scanning, confirmation for `reset --hard`, `checkout --`, `clean -f`.                                                                                                                                                                                                                                        |

### GitHub (2 tools)

| Tool       | Permission | Description                                                                                                                                                                                            |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gh_issue` | confirm    | Create, list, or view GitHub issues via the `gh` CLI. Create supports title, body, labels, assignees. List supports state filter, label filter, limit. View returns full issue with comments.          |
| `gh_pr`    | confirm    | Create, list, or view GitHub pull requests via the `gh` CLI. Create supports title, body, base branch, draft mode. List supports state filter. View returns PR details with additions/deletions/files. |

### Web (2 tools)

| Tool         | Permission | Description                                                                                                                                 |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_fetch`  | auto       | Fetch URL content. 10s timeout. Max response length configurable (default: 10,000 chars). Returns content, truncation status, content type. |
| `web_search` | auto       | Search the web via DuckDuckGo HTML scraping. Returns up to 5 results with titles and snippets.                                              |

### Tasks (3 tools)

| Tool          | Permission | Description                                                                                                |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `task_create` | auto       | Create an in-session task to track multi-step work progress. Returns task ID. Emits event for TUI display. |
| `task_update` | auto       | Update task status: `pending`, `in_progress`, `completed`, `failed`.                                       |
| `task_list`   | auto       | List all tasks in the current session with their status.                                                   |

### Memory (4 tools)

| Tool            | Permission | Description                                                                                                                                                                                                       |
| --------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_save`   | auto       | Save important information to persistent memory across sessions. Categories: `decision`, `convention`, `warning`, `general`. Blocks: `project`, `user`, `reference`. Writes to both file-based and SQLite stores. |
| `memory_search` | auto       | Search persistent memory by keyword. Searches both file-based and project memory stores. Deduplicates results. Max 10 results.                                                                                    |
| `memory_list`   | auto       | List all saved memories, optionally filtered by category. Merges file-based and project memories.                                                                                                                 |
| `memory_forget` | confirm    | Remove a memory entry that is no longer relevant or accurate. Deletes from both stores.                                                                                                                           |

### Transactions (3 tools)

| Tool                   | Permission | Description                                                                                                                                                                                            |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `begin_transaction`    | auto       | Start an atomic transaction for multi-file edits. All file writes between begin and commit/rollback are tracked. For coordinated changes where partial application would break the build.              |
| `commit_transaction`   | auto       | Finalize a transaction. All tracked file writes are kept. Returns list of committed files.                                                                                                             |
| `rollback_transaction` | confirm    | Rollback a transaction. Reverts all file writes using checkpoint snapshots. Dependency-aware ordering: dependents reverted before dependencies. Reports partial rollback if some files lack snapshots. |

### BrainstormRouter Intelligence (8 tools)

| Tool               | Permission | Description                                                                                                               |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `br_status`        | auto       | Self-check: identity, budget remaining, provider health, recent errors, suggestions.                                      |
| `br_budget`        | auto       | Budget status + forecast: daily/monthly spend, limits, remaining balance.                                                 |
| `br_leaderboard`   | auto       | Real model performance rankings from production data. Sortable by: overall, quality, speed, reliability, cost_efficiency. |
| `br_insights`      | auto       | Cost optimization recommendations: waste identification, cheaper model suggestions, savings estimates.                    |
| `br_models`        | auto       | List all available models through BrainstormRouter with pricing.                                                          |
| `br_memory_search` | auto       | Search BrainstormRouter persistent memory by keyword. Cloud-persisted across sessions.                                    |
| `br_memory_store`  | confirm    | Save facts to BrainstormRouter persistent memory. Types: semantic (knowledge), episodic (events), procedural (how-to).    |
| `br_health`        | auto       | Quick health check: version, uptime, endpoint counts. Connectivity test.                                                  |

### Planning (1 tool)

| Tool           | Permission | Description                                                                                                                                                                                   |
| -------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan_preview` | auto       | Format a multi-step plan for user presentation. Takes summary, ordered steps with tool lists, optional cost estimate. Returns formatted plan with instruction to use `ask_user` for approval. |

### Interaction (2 tools)

| Tool            | Permission | Description                                                                                                                                                           |
| --------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask_user`      | auto       | Present interactive choices to the user. 2-6 options with labels, descriptions, and recommended flags. Renders as SelectPrompt in the TUI. Blocks until user selects. |
| `cost_estimate` | auto       | Show estimated costs across three model tiers (quality, balanced, cheap) for a task. Used before expensive operations to let the user choose tier.                    |

### Routing (1 tool)

| Tool               | Permission | Description                                                                                                                            |
| ------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `set_routing_hint` | auto       | Agent self-selects routing preference for the next model selection: `cheap`, `quality`, `fast`, or `auto`. Consumed once, then resets. |

### Scratchpad (2 tools)

| Tool               | Permission | Description                                                                                                     |
| ------------------ | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `scratchpad_write` | auto       | Save a note that survives context compaction. For key decisions, current task state, constraints. Not for code. |
| `scratchpad_read`  | auto       | Read scratchpad notes. Omit key to read all notes.                                                              |

### Undo (1 tool)

| Tool              | Permission | Description                                                                                           |
| ----------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `undo_last_write` | confirm    | Revert the most recent file write or edit using checkpoint snapshots. Optionally specify a file path. |

---

## 2. Slash Commands

Commands executed with the `/` prefix in chat mode. Dispatched by `packages/cli/src/commands/slash.ts`.

### Chat Commands

| Command     | Aliases       | Description                                                                   | Usage                                                                     |
| ----------- | ------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/help`     | `/h`, `/?`    | Show available commands or detailed help for a specific command               | `/help [command]`                                                         |
| `/model`    | `/m`          | Switch or show the active model                                               | `/model [name]`                                                           |
| `/strategy` | `/fast`       | Switch routing strategy. `/fast` toggles between cost-first and quality-first | `/strategy [cost-first\|quality-first\|combined\|capability\|rule-based]` |
| `/mode`     | --            | Switch permission mode                                                        | `/mode [auto\|confirm\|plan]`                                             |
| `/cost`     | `/$`          | Show session cost and token counts                                            | `/cost`                                                                   |
| `/budget`   | --            | Show remaining budget (if set)                                                | `/budget`                                                                 |
| `/clear`    | --            | Clear conversation history                                                    | `/clear`                                                                  |
| `/compact`  | --            | Compact context with optional focus instruction                               | `/compact [focus instruction]`                                            |
| `/style`    | --            | Switch output style                                                           | `/style [concise\|detailed\|learning]`                                    |
| `/quit`     | `/exit`, `/q` | Exit Brainstorm                                                               | `/quit`                                                                   |
| `/context`  | --            | Show token breakdown for the current context                                  | `/context`                                                                |

### Role Commands

| Command            | Description                                                                    | Usage                       |
| ------------------ | ------------------------------------------------------------------------------ | --------------------------- |
| `/architect`       | Deep thinking, system design, read-only exploration. Default: Claude Opus 4.6  | `/architect [model-number]` |
| `/product-manager` | Requirements, user stories, acceptance criteria. Default: Claude Opus 4.6      | `/product-manager [N]`      |
| `/sr-developer`    | Quality implementation with best models. Default: Claude Sonnet 4.6            | `/sr-developer [N]`         |
| `/jr-developer`    | Fast, cheap implementation for well-specified tasks. Default: Claude Haiku 4.5 | `/jr-developer [N]`         |
| `/qa`              | Testing, code review, edge case discovery. Default: Claude Sonnet 4.6          | `/qa [N]`                   |
| `/role`            | Show current role or list available roles                                      | `/role`                     |
| `/default`         | Reset to default session state (no role)                                       | `/default`                  |

### Build Commands

| Command            | Aliases | Description                                                                                                      | Usage                  |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `/build`           | --      | Multi-model workflow wizard: describe task, auto-detect workflow, assign models per step, estimate cost, execute | `/build [description]` |
| `/build-go`        | --      | Execute the pending pipeline from the wizard                                                                     | `/build-go`            |
| `/build-customize` | --      | See model options per pipeline step                                                                              | `/build-customize`     |

### Intelligence Commands

| Command         | Aliases  | Description                                                                 | Usage                    |
| --------------- | -------- | --------------------------------------------------------------------------- | ------------------------ |
| `/recommend`    | --       | Get model recommendation from BrainstormRouter                              | `/recommend [type]`      |
| `/stats`        | --       | Session analytics + BrainstormRouter usage                                  | `/stats`                 |
| `/intelligence` | `/intel` | Show what BrainstormRouter has learned: leaderboard, usage, waste, forecast | `/intelligence [--json]` |

### System Commands

| Command        | Aliases           | Description                                                             | Usage                                                          |
| -------------- | ----------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `/vault`       | `/keys`           | Manage API keys in the encrypted vault                                  | `/vault [list\|add <name>\|get <name>\|remove <name>\|status]` |
| `/dream`       | `/consolidate`    | Consolidate memory files: merge duplicates, fix dates, prune stale refs | `/dream`                                                       |
| `/project`     | `/proj`           | Manage projects: switch, list, register, show dashboard                 | `/project [name\|list\|register\|show <name>]`                 |
| `/schedule`    | `/sched`, `/cron` | Manage scheduled tasks for the active project                           | `/schedule [list\|add\|history]`                               |
| `/orchestrate` | `/orch`           | Coordinate work across multiple projects                                | `/orchestrate "<description>" [project1,project2,...]`         |

---

## 3. Roles

Session presets that atomically configure model, system prompt, tools, output style, and routing strategy. Defined in `packages/cli/src/commands/roles.ts`.

### Architect

- **Icon:** Building crane
- **Color:** Magenta
- **Description:** Deep thinking, system design, read-only exploration
- **Output Style:** detailed
- **Permission Mode:** plan (read-only)
- **Routing Strategy:** quality-first
- **Persona:** Expert playbook with model-tuned prompts
- **Model Choices:**
  1. Claude Opus 4.6 ($15/$75 per 1M) -- default
  2. GPT-5.4 ($2.50/$10)
  3. Gemini 3.1 Pro ($1.25/$5)
  4. Claude Sonnet 4.6 ($3/$15)

### Product Manager

- **Icon:** Clipboard
- **Color:** Blue
- **Description:** Requirements, user stories, acceptance criteria
- **Output Style:** detailed
- **Permission Mode:** plan
- **Routing Strategy:** quality-first
- **Model Choices:**
  1. Claude Opus 4.6 ($15/$75) -- default
  2. GPT-5.4 ($2.50/$10)
  3. Gemini 3.1 Pro ($1.25/$5)

### Sr. Developer

- **Icon:** Developer
- **Color:** Green
- **Description:** Quality implementation with best models
- **Output Style:** concise
- **Permission Mode:** confirm
- **Routing Strategy:** quality-first
- **Model Choices:**
  1. Claude Sonnet 4.6 ($3/$15) -- default
  2. GPT-5.4 ($2.50/$10)
  3. DeepSeek V3 ($0.27/$1.10)
  4. Gemini 3.1 Pro ($1.25/$5)

### Jr. Developer

- **Icon:** Junior developer
- **Color:** Yellow
- **Description:** Fast, cheap implementation for well-specified tasks
- **Output Style:** concise
- **Permission Mode:** confirm
- **Routing Strategy:** cost-first
- **Model Choices:**
  1. Claude Haiku 4.5 ($0.80/$4) -- default
  2. GPT-4.1 Mini ($0.40/$1.60)
  3. Gemini 3.1 Flash ($0.15/$0.60)
  4. DeepSeek V3 ($0.27/$1.10)

### QA Engineer

- **Icon:** Magnifying glass
- **Color:** Red
- **Description:** Testing, code review, edge case discovery
- **Output Style:** detailed
- **Permission Mode:** plan
- **Routing Strategy:** quality-first
- **Model Choices:**
  1. Claude Sonnet 4.6 ($3/$15) -- default
  2. GPT-5.4 ($2.50/$10)
  3. Gemini 3.1 Pro ($1.25/$5)
  4. Claude Opus 4.6 ($15/$75)

---

## 4. Routing Strategies

Six strategies in `packages/router/src/strategies/`. The router classifies tasks by type and complexity using heuristic keyword matching (no LLM call), then applies the active strategy.

### Task Classification

The heuristic classifier (`packages/router/src/classifier.ts`) detects:

- **Task Types (9):** simple-edit, code-generation, refactoring, debugging, explanation, conversation, analysis, search, multi-file-edit
- **Complexity (5):** trivial, simple, moderate, complex, expert
- **Language:** TypeScript, JavaScript, Python, Rust, Go
- **Domain:** frontend, backend, devops
- **Tool requirement:** derived from task type + explicit keywords
- **Reasoning requirement:** derived from complexity + task type

Results are memoized (20-entry LRU cache).

### 4.1 Cost-First

Selects the cheapest model meeting a minimum quality threshold. Each task type has a minimum quality tier (e.g., simple-edit requires tier 5, debugging requires tier 2). Local models (cost $0) are preferred. Returns up to 3 fallbacks sorted by cost.

### 4.2 Quality-First

Selects the highest-quality available model. Sorts by quality tier (1=best), then speed as tiebreaker. Filters models exceeding session or daily budget limits. Prefers explicit models over `brainstormrouter/auto`.

### 4.3 Combined (default)

Three-tier approach:

1. **Rule-based first:** if any user-defined rule matches, use it
2. **Trivial/simple tasks:** delegate to cost-first
3. **Complex/expert tasks:** delegate to quality-first
4. **Moderate tasks:** weighted scoring: 40% quality + 35% cost + 15% speed + affinity bonus for `bestFor` matches

### 4.4 Capability

Matches task requirements to model capability scores from eval probes. Maps task properties to 7 capability dimensions with weights. Scores each model using eval data (or derived tier score as fallback). Cost is a tiebreaker, not primary. Auto-activates when eval data is available.

### 4.5 Learned (Thompson Sampling)

Client-side Bayesian bandit. Records `(taskType, modelId, success, latency, cost)` per turn. Uses Beta distribution sampling to balance exploration vs exploitation. Models with no history get an optimistic prior (0.7 + random 0-0.3). Statistics persist via the `session_patterns` table.

### 4.6 Rule-Based

User-defined rules in TOML config. Each rule has a `match` block (task type, complexity, language) and an action (specific model or preferred provider). Rules are evaluated in order; first match wins.

### Additional Router Features

- **Fallback chain:** every routing decision includes up to 3 fallback models
- **Momentum:** the router tracks consecutively successful models and prefers them
- **Failure tracking:** recent model failures are recorded and penalized
- **Project hints:** BRAINSTORM.md frontmatter can declare `primary_tasks`, `typical_complexity`, influencing classification
- **Cost tracking:** `CostTracker` records per-session and per-project costs with forecast

---

## 5. Agent Types

### 5.1 Subagent Types (7)

Spawnable subagents used by the workflow engine and orchestration pipeline:

| Type          | Description                                   |
| ------------- | --------------------------------------------- |
| **explore**   | Read-only exploration, codebase understanding |
| **plan**      | Architecture and design planning              |
| **code**      | Implementation with write access              |
| **review**    | Code review and quality assessment            |
| **general**   | General-purpose assistant                     |
| **decompose** | Break complex tasks into subtasks             |
| **external**  | External tool integration                     |

### 5.2 Agent Roles (7)

Roles defined in agent profiles and config:

| Role           | Description                                                 |
| -------------- | ----------------------------------------------------------- |
| `architect`    | System design, interface contracts, implementation planning |
| `coder`        | Code implementation, builds, self-verification              |
| `reviewer`     | Code review for correctness, security, conventions          |
| `debugger`     | Root cause analysis and fix recommendations                 |
| `analyst`      | Technical explanation and analysis                          |
| `orchestrator` | Workflow coordination, delegation, retry management         |
| `custom`       | User-defined role                                           |

### 5.3 Built-in Agent Definitions (11)

Located in `.brainstorm/agents/` as `.agent.md` files with YAML frontmatter:

| Agent                 | Role      | Tools                                                                                 | Max Steps | Description                                                                                |
| --------------------- | --------- | ------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| **Architect**         | architect | file_read, grep, glob, git_log, git_diff, list_dir                                    | 12        | Designs technical solutions: components, interfaces, data flow, file changes               |
| **Coder**             | coder     | file_read, file_write, file_edit, multi_edit, glob, grep, shell, git_status, git_diff | 15        | Implements code changes from designs -- production-grade code that builds and passes tests |
| **Code Reviewer**     | reviewer  | file_read, grep, glob, git_diff, git_log, git_status                                  | 8         | Reviews code for correctness, quality, and convention compliance                           |
| **Security Reviewer** | reviewer  | file_read, grep, glob, git_diff, git_log                                              | 8         | Reviews code for security vulnerabilities and credential leaks (confidence threshold: 0.8) |
| **Style Reviewer**    | reviewer  | file_read, grep, glob, git_diff                                                       | 5         | Reviews code for style consistency and naming conventions                                  |
| **Product Manager**   | analyst   | file_read, grep, glob, git_log, web_search                                            | 10        | Writes specifications from user requests -- requirements, acceptance criteria, scope       |
| **Refactorer**        | coder     | file_read, file_edit, grep, glob, git_diff                                            | 10        | Improves code quality without changing behavior                                            |
| **Build Verifier**    | coder     | shell, file_read                                                                      | 5         | Runs build and test commands, reports pass/fail with error details                         |
| **DevOps**            | coder     | shell, file_read, file_write, git_status, git_diff                                    | 10        | Handles deployment, CI/CD pipeline, infrastructure operations                              |
| **Technical Writer**  | analyst   | file_read, file_write, grep, glob, git_log, git_diff                                  | 8         | Generates documentation: changelogs, API docs, README updates                              |
| **Reporter**          | analyst   | file_read, grep, glob                                                                 | 5         | Produces execution summary reports: changes, costs, findings, next steps                   |

### Agent Priority Resolution

When resolving an agent by role: `.agent.md` files > TOML config > SQLite database.

---

## 6. Middleware Pipeline

11 middleware in the default pipeline, executed in order. Defined in `packages/core/src/middleware/`. Each middleware can implement up to 4 hooks: `beforeAgent`, `afterModel`, `wrapToolCall`, `afterToolResult`.

| #   | Middleware               | Hook Points     | Description                                                                                                                                                                                          |
| --- | ------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **turn-context**         | beforeAgent     | Injects TurnContext summary between turns for agent self-awareness                                                                                                                                   |
| 2   | **tool-health**          | beforeAgent     | Filters unhealthy tools from the available tool set                                                                                                                                                  |
| 3   | **build-state**          | afterToolResult | Tracks build/test results from shell commands and injects warnings when build is broken                                                                                                              |
| 4   | **loop-detection**       | wrapToolCall    | Detects repetitive tool call patterns (e.g., reading same file 4+ times). Hook point for auto-blocking                                                                                               |
| 5   | **sentiment**            | beforeAgent     | Detects user tone (frustrated, urgent, exploring, appreciative) and adjusts response style. Frustrated: be direct, lead with fix. Urgent: minimize reads, act quickly. Exploring: offer alternatives |
| 6   | **subagent-limit**       | afterModel      | Hardware-enforces max 3 concurrent subagent spawns. Truncates excess `spawn_subagent`/`spawn_parallel` calls                                                                                         |
| 7   | **trajectory-reduction** | beforeAgent     | Marks state for trajectory reduction -- prunes expired/redundant context before next LLM call                                                                                                        |
| 8   | **auto-lint**            | afterToolResult | Triggers linting after file write/edit tool calls (`file_write`, `file_edit`, `multi_edit`, `batch_edit`)                                                                                            |
| 9   | **proactive-compaction** | beforeAgent     | Monitors context usage. At 60%: injects "stay focused" hint. At 75%: injects "wrap up" warning. Prevents surprise compaction at 80% threshold                                                        |
| 10  | **security-scan**        | afterToolResult | Scans written content for credentials after every file write. Warns on git commit if credentials detected during session. Uses same 7-pattern scanner as git_commit                                  |
| 11  | **memory-extraction**    | afterModel      | Scans assistant responses for extractable facts via regex heuristics (no LLM call). Extracts user preferences, project conventions, error-fix pairs. Saves to MemoryManager                          |

---

## 7. Hook Points

9 lifecycle events defined in `packages/hooks/src/types.ts`. Hooks are deterministic automation that always runs when triggered, unlike LLM decisions.

| Event           | When                               | Matcher Target        | Can Block                 |
| --------------- | ---------------------------------- | --------------------- | ------------------------- |
| `PreToolUse`    | Before a tool executes             | Tool name (regex)     | Yes (if `blocking: true`) |
| `PostToolUse`   | After a tool succeeds              | Tool name (regex)     | No                        |
| `SessionStart`  | When a session begins or resumes   | --                    | No                        |
| `SessionEnd`    | When a session ends                | --                    | No                        |
| `Stop`          | When the agent finishes responding | --                    | No                        |
| `PreCompact`    | Before context compaction          | --                    | No                        |
| `PreCommit`     | Before a git commit                | --                    | No                        |
| `SubagentStart` | When a subagent is spawned         | Subagent type (regex) | No                        |
| `SubagentStop`  | When a subagent completes          | Subagent type (regex) | No                        |

### Hook Types

- **command:** Runs a shell command. Variables expanded: `$FILE`, `$TOOL`, `$SUBAGENT_TYPE`, `$SUBAGENT_COST`, `$SUBAGENT_MODEL`. Shell-escaped to prevent injection. 10s timeout.
- **prompt:** Asks an LLM (not yet implemented; use `command` type).

### Hook Configuration

Hooks are defined in TOML config or registered programmatically via `HookManager`. Example:

```toml
[[hooks]]
event = "PostToolUse"
matcher = "file_write|file_edit"
type = "command"
command = "npx eslint --fix $FILE"
description = "Auto-lint after file writes"
```

---

## 8. TUI Modes

4-mode Ink TUI switchable with Esc and number keys. Components in `packages/cli/src/components/`.

### Mode 1: Chat (default)

Always mounted (hidden via `display:none` when not active). Handles all 23 AgentEvent types.

**Components:**

- **MessageList.tsx** -- Scrollable conversation with React.memo, role-based styling (blue=user, green=assistant, red=error)
- **StreamingMessage.tsx** -- ink-spinner with phase labels, markdown rendering with cursor
- **ToolCallDisplay.tsx** -- Spinner while running, checkmark/X on complete, tool-specific arg summaries
- **SelectPrompt.tsx** -- Interactive selection (arrow keys, Enter, Esc, multi-select with Space)
- **Autocomplete.tsx** -- Filtered dropdown for `/` commands
- **DiffRenderer.tsx** -- Unified diff display
- **MarkdownRenderer.tsx** -- Terminal markdown rendering
- **TaskList.tsx** -- Displays in-session task progress
- **ProgressIndicator.tsx** -- Progress bar component
- **StatusBar.tsx** -- Bottom status information

### Mode 2: Dashboard

**DashboardMode.tsx** -- Session statistics, routing log, tool health, BrainstormRouter leaderboard/waste/audit.

### Mode 3: Models

**ModelsMode.tsx** -- Interactive model list with detail panel and gauges. Browse available models with pricing and capability scores.

### Mode 4: Config

**ConfigMode.tsx** -- Active configuration display, vault status, memory counts, quick reference.

### Mode 5: Planning

**PlanningMode.tsx** -- Plan visualization with **PlanTree.tsx** component for hierarchical task display.

### Shared Components

- **ModeBar.tsx** -- Tab indicators with role/model/cost/guardian status
- **ShortcutOverlay.tsx** -- Full-screen keyboard reference (activated with `?`)
- **KeyHint.tsx** -- Keyboard shortcut hints
- **App.tsx** -- Top-level mode switcher, captures routing/tool/cost events from agent stream

### Visualization Components

- **Gauge.tsx** -- Visual gauge display
- **Sparkline.tsx** -- Inline sparkline charts

### Keyboard Shortcuts

- **Esc** -- Toggle between Chat and Dashboard
- **1-4** -- Switch to specific mode (Chat, Dashboard, Models, Config)
- **Shift+Tab** -- Cycle permission mode
- **?** -- Show shortcut overlay

---

## 9. Workflow Presets

4 preset workflows in `packages/workflow/src/presets.ts`. Auto-selected from natural language descriptions.

### 9.1 Implement Feature

- **ID:** `implement-feature`
- **Communication:** handoff
- **Max Iterations:** 3
- **Steps:**
  1. **plan** (architect) -- Create detailed implementation plan with file structure, interfaces, step-by-step instructions. Output: `spec`
  2. **code** (coder) -- Implement code according to specification. Input: spec. Output: `code`
  3. **review** (reviewer) -- Review implementation for correctness, security, spec adherence. Input: spec + code. Output: `review`. Loop back to `code` on rejection
- **Trigger keywords:** build, implement, add, create, scaffold, new feature

### 9.2 Fix Bug

- **ID:** `fix-bug`
- **Communication:** handoff
- **Max Iterations:** 2
- **Steps:**
  1. **diagnose** (debugger) -- Identify root cause, recommend fix. Output: `diagnosis`
  2. **fix** (coder) -- Implement fix based on diagnosis. Input: diagnosis. Output: `code`
  3. **verify** (reviewer) -- Verify fix addresses root cause. Input: diagnosis + code. Output: `review`. Loop back to `fix` on rejection
- **Trigger keywords:** fix, debug, error, broken, bug, crash, failing

### 9.3 Code Review

- **ID:** `code-review`
- **Communication:** handoff
- **Max Iterations:** 1
- **Steps:**
  1. **review** (reviewer) -- Review code for bugs, security, performance, style. Output: `review`
- **Trigger keywords:** review, check, audit, inspect

### 9.4 Explain

- **ID:** `explain`
- **Communication:** handoff
- **Max Iterations:** 1
- **Steps:**
  1. **explain** (analyst) -- Provide clear, thorough technical explanation. Output: `explanation`
- **Trigger keywords:** explain, what is, how does, why, describe, understand

### Workflow Engine Features

- **Artifact passing:** steps produce and consume named artifacts
- **Confidence extraction:** extracts approval confidence from review steps
- **Escalation:** determines when to escalate based on confidence thresholds
- **Context filtering:** builds step-specific context from artifacts
- **Build state awareness:** pauses workflow if build is broken
- **Per-step model overrides:** assign different models to different pipeline steps

---

## 10. Configuration

TOML configuration with layered resolution: defaults < global (`~/.brainstorm/config.toml`) < project (`./brainstorm.toml`) < environment variables.

### [general]

| Key                            | Type    | Default      | Description                                                                            |
| ------------------------------ | ------- | ------------ | -------------------------------------------------------------------------------------- |
| `defaultStrategy`              | enum    | `"combined"` | Routing strategy: cost-first, quality-first, rule-based, combined, capability, learned |
| `confirmTools`                 | boolean | `true`       | Require confirmation for confirm-level tools                                           |
| `defaultPermissionMode`        | enum    | `"confirm"`  | Permission mode: auto, confirm, plan                                                   |
| `theme`                        | enum    | `"dark"`     | UI theme: dark, light                                                                  |
| `maxSteps`                     | number  | `10`         | Maximum agentic steps per turn                                                         |
| `outputStyle`                  | enum    | `"concise"`  | Output style: concise, detailed, learning                                              |
| `costSafetyMargin`             | number  | `1.3`        | Multiplier for cost estimates (1.0-3.0)                                                |
| `loopDetector.readThreshold`   | number  | `4`          | How many times a file can be read before warning                                       |
| `loopDetector.repeatThreshold` | number  | `3`          | How many identical tool calls before warning                                           |
| `subagentIsolation`            | enum    | `"none"`     | Subagent filesystem isolation: none, git-stash, docker                                 |

### [compaction]

| Key              | Type    | Default    | Description                                                     |
| ---------------- | ------- | ---------- | --------------------------------------------------------------- |
| `enabled`        | boolean | `true`     | Enable automatic context compaction                             |
| `threshold`      | number  | `0.8`      | Trigger compaction at this fraction of context window (0.1-1.0) |
| `keepRecent`     | number  | `5`        | Keep this many recent messages uncompacted                      |
| `summarizeModel` | string  | (optional) | Specific model to use for compaction summaries                  |

### [shell]

| Key                | Type   | Default          | Description                                 |
| ------------------ | ------ | ---------------- | ------------------------------------------- |
| `defaultTimeout`   | number | `120000`         | Default shell command timeout in ms         |
| `maxOutputBytes`   | number | `50000`          | Max output bytes (split 40% head, 60% tail) |
| `sandbox`          | enum   | `"none"`         | Sandbox level: none, restricted, container  |
| `containerImage`   | string | `"node:22-slim"` | Docker image for container sandbox          |
| `containerTimeout` | number | `120000`         | Docker command timeout in ms                |

### [budget]

| Key          | Type    | Default    | Description                                      |
| ------------ | ------- | ---------- | ------------------------------------------------ |
| `daily`      | number  | (optional) | Daily spending limit in USD                      |
| `monthly`    | number  | (optional) | Monthly spending limit                           |
| `perSession` | number  | (optional) | Per-session spending limit                       |
| `perProject` | number  | (optional) | Per-project spending limit                       |
| `hardLimit`  | boolean | `false`    | If true, hard-stop at limit; if false, warn only |

### [providers]

| Key                   | Type    | Default                             | Description                     |
| --------------------- | ------- | ----------------------------------- | ------------------------------- |
| `gateway.enabled`     | boolean | `true`                              | Enable AI Gateway provider      |
| `gateway.apiKeyEnv`   | string  | `"AI_GATEWAY_API_KEY"`              | Env var for gateway API key     |
| `gateway.baseUrl`     | string  | `"https://ai-gateway.vercel.sh/v1"` | Gateway base URL                |
| `ollama.enabled`      | boolean | `true`                              | Enable Ollama local provider    |
| `ollama.baseUrl`      | string  | `"http://localhost:11434"`          | Ollama URL                      |
| `ollama.autoDiscover` | boolean | `true`                              | Auto-discover Ollama models     |
| `lmstudio.enabled`    | boolean | `true`                              | Enable LM Studio local provider |
| `lmstudio.baseUrl`    | string  | `"http://localhost:1234"`           | LM Studio URL                   |
| `llamacpp.enabled`    | boolean | `false`                             | Enable llama.cpp local provider |
| `llamacpp.baseUrl`    | string  | `"http://localhost:8080"`           | llama.cpp URL                   |

### [permissions]

| Key         | Type     | Default    | Description                                                                                      |
| ----------- | -------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `allowlist` | string[] | `[]`       | Tools that always auto-approve                                                                   |
| `denylist`  | string[] | `[]`       | Tools that are always blocked                                                                    |
| `role`      | enum     | (optional) | Permission preset: viewer (read-only), developer (confirm destructive), admin (auto-approve all) |

### [routing]

| Key     | Type  | Default | Description                                     |
| ------- | ----- | ------- | ----------------------------------------------- |
| `rules` | array | `[]`    | Routing rules with match conditions and actions |

Each rule:

```toml
[[routing.rules]]
[routing.rules.match]
task = "debugging"           # Task type filter
complexity = "complex"       # Complexity filter
language = "typescript"      # Language filter
model = "anthropic/claude-sonnet-4-6"  # Route to this model
preferProvider = "anthropic"           # Or prefer this provider
strategy = "quality-first"             # Or use this strategy
```

### [models]

Override model metadata:

```toml
[[models]]
id = "openai/gpt-5.4"
qualityTier = 1
speedTier = 2
bestFor = ["code-generation", "debugging"]
```

### [[agents]]

Define agents in TOML:

```toml
[[agents]]
id = "my-architect"
role = "architect"
model = "anthropic/claude-opus-4-6"
maxSteps = 15
confidenceThreshold = 0.8
[agents.budget]
perWorkflow = 1.0
daily = 5.0
exhaustionAction = "downgrade"
downgradeModel = "anthropic/claude-sonnet-4-6"
[agents.guardrails]
pii = true
```

### [[workflows]]

Define custom workflows:

```toml
[[workflows]]
id = "my-workflow"
name = "Custom Pipeline"
communicationMode = "handoff"
maxIterations = 3
[[workflows.steps]]
id = "step1"
agentRole = "architect"
outputArtifact = "spec"
```

### [mcp]

MCP server configuration:

```toml
[[mcp.servers]]
name = "my-server"
transport = "sse"         # sse, http, or stdio
url = "http://localhost:3001/sse"
enabled = true
toolFilter = ["tool1", "tool2"]
[mcp.servers.auth]
type = "oauth"
clientId = "..."
clientSecret = "..."
tokenUrl = "..."
scopes = ["read", "write"]
```

---

## 11. Database Schema

SQLite database at `~/.brainstorm/brainstorm.db` with WAL mode and foreign keys. 22 migrations. Auto-cleanup of records older than 90 days.

### Tables

| Table                  | Description                         | Key Columns                                                                                                                                   |
| ---------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`             | Chat sessions                       | id, project_path, project_id, total_cost, message_count, created_at                                                                           |
| `messages`             | Conversation messages               | id, session_id, role (user/assistant/system/tool), content, model_id, token_count                                                             |
| `cost_records`         | Per-turn cost tracking              | session_id, model_id, provider, input_tokens, output_tokens, cached_tokens, cost, task_type, project_path                                     |
| `model_performance`    | Model success/failure tracking (v1) | model_id, task_type, success, latency_ms, user_accepted                                                                                       |
| `model_performance_v2` | Enhanced model performance          | model_id, task_type, shape_key, success, latency_ms, cost_usd, validity_score, quality_score, input/output_tokens                             |
| `agent_profiles`       | Stored agent configurations         | id, role, model_id, system_prompt, allowed_tools, budget_per_workflow, confidence_threshold, max_steps, fallback_chain, guardrails, lifecycle |
| `workflow_definitions` | Custom workflow templates           | id, name, steps_json, communication_mode, max_iterations                                                                                      |
| `workflow_runs`        | Workflow execution records          | id, workflow_id, session_id, status, total_cost, iteration                                                                                    |
| `workflow_step_runs`   | Individual step results             | run_id, step_def_id, agent_id, status, artifact_json, cost                                                                                    |
| `session_patterns`     | Learned session patterns            | project_path, pattern_type (tool_success/command_timing/user_preference/model_choice), key, value, confidence, occurrences                    |
| `session_checkpoints`  | Session state snapshots             | session_id, turn_number, state_json                                                                                                           |
| `session_locks`        | Concurrent session prevention       | session_id, holder                                                                                                                            |
| `audit_log`            | Tool execution audit trail          | session_id, tool_name, args_json, result_ok, duration_ms, model_id, cost                                                                      |
| `code_embeddings`      | TF-IDF code search index            | project_path, file_path, symbol_name, content_snippet, tfidf_vector                                                                           |
| `projects`             | Registered projects                 | id, name, path, description, custom_instructions, knowledge_files, budget_daily, budget_monthly                                               |
| `project_memory`       | Per-project structured memory       | project_id, key, value, category                                                                                                              |
| `scheduled_tasks`      | Automated scheduled tasks           | project_id, name, prompt, cron_expression, execution_mode, allow_mutations, budget_limit, model_id, status                                    |
| `scheduled_task_runs`  | Scheduled task execution history    | task_id, session_id, status, trigger_type, output_summary, cost, turns_used                                                                   |
| `orchestration_runs`   | Cross-project orchestration runs    | name, description, lead_session_id, status, project_ids, total_cost                                                                           |
| `orchestration_tasks`  | Individual orchestration tasks      | run_id, project_id, prompt, subagent_type, result_summary, cost                                                                               |
| `plan_runs`            | Plan execution records              | plan_file_path, plan_name, project_id, status, total_tasks, completed_tasks, total_cost                                                       |
| `plan_task_runs`       | Individual plan task results        | plan_run_id, task_path, description, assigned_skill, subagent_type, model_used, cost                                                          |

---

## 12. MCP Integration

Model Context Protocol client in `packages/mcp/src/`. Connects to external MCP servers and registers their tools into the same ToolRegistry as built-in tools.

### Transports

| Transport | Description                                     |
| --------- | ----------------------------------------------- |
| **SSE**   | Server-Sent Events (long-lived HTTP connection) |
| **HTTP**  | Standard HTTP request/response                  |
| **stdio** | Subprocess communication via stdin/stdout       |

### Features

- **OAuth authentication:** `client_credentials` grant type for secured servers
- **Tool normalization:** Fixes missing `type: "object"` in input schemas for Anthropic compatibility
- **Tool filtering:** Optional `toolFilter` array to only register specific tools from a server
- **Environment variables:** Pass env vars to stdio server processes
- **Auto-connection:** All enabled servers connected at startup via `connectAll()`
- **Uses `@ai-sdk/mcp`** for SSE/HTTP transport implementation

### Configuration

MCP servers are configured in TOML config under `[mcp]` or in `.brainstorm/mcp.json`:

```json
{
  "servers": [
    {
      "name": "my-mcp-server",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "API_KEY": "..." }
    }
  ]
}
```

---

## 13. Vault

Encrypted key storage in `packages/vault/src/`. Local-first with multi-backend fallback.

### Encryption

- **Algorithm:** AES-256-GCM
- **Key Derivation:** Argon2id (OWASP-recommended parameters)
  - Memory: 64 MB
  - Iterations: 3
  - Parallelism: 4
  - Key length: 256 bits
- **Salt:** 32 random bytes
- **Nonce:** 12 random bytes per encryption
- **Storage:** `~/.brainstorm/vault.json` (version 1 format)
- **Auto-lock:** configurable (default: 30 minutes of inactivity)

### Key Resolver Chain

The `KeyResolver` tries backends in priority order:

1. **Local encrypted vault** -- lazy unlock on first access; re-prompts if previous password attempt failed
2. **1Password CLI** -- `op read "op://Dev Keys/<item>/credential"` (if `op` available and `OP_SERVICE_ACCOUNT_TOKEN` set)
3. **Environment variables** -- standard env var lookup

### Vault Operations

| Operation | Description                             |
| --------- | --------------------------------------- |
| `init`    | Create a new vault with master password |
| `open`    | Decrypt and hold keys in memory         |
| `lock`    | Clear keys from memory                  |
| `get`     | Retrieve a key by name                  |
| `set`     | Store a key                             |
| `list`    | List all stored key names               |
| `remove`  | Delete a key                            |
| `rotate`  | Change the master password              |
| `status`  | Report backend availability             |

### 1Password Backend

- Vault name: "Dev Keys"
- Item name mapping in `packages/vault/src/backends/op-cli.ts`
- Availability cached to avoid repeated checks
- Falls through silently if `op` not available

---

## 14. Plugin SDK

Extension system in `packages/plugin-sdk/src/`. Plugins can provide tools, hooks, and skills.

### Plugin Structure

```typescript
import {
  defineBrainstormPlugin,
  definePluginTool,
} from "@brainst0rm/plugin-sdk";
import { z } from "zod";

export default defineBrainstormPlugin({
  name: "my-plugin", // lowercase, hyphens allowed
  description: "Description",
  version: "1.0.0", // semver required
  tools: [
    /* PluginToolDef[] */
  ],
  hooks: [
    /* PluginHookDef[] */
  ],
  skills: [
    /* PluginSkillDef[] */
  ],
  onLoad: async () => {}, // setup
  onUnload: async () => {}, // cleanup
});
```

### Extension Points

| Extension  | Description                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tools**  | Same shape as built-in tools: name, description, permission (auto/confirm), Zod inputSchema, async execute function                                                 |
| **Hooks**  | Lifecycle event handlers: event, optional matcher (regex), shell command, blocking flag, description                                                                |
| **Skills** | Reusable instruction bundles: name, description, system prompt override, tool restrictions, model preference (cheap/quality/fast/auto), max steps, markdown content |

### Plugin Manifest

```json
{
  "name": "my-plugin",
  "description": "...",
  "version": "1.0.0",
  "author": "...",
  "main": "./dist/index.js",
  "brainstormVersion": ">=0.1.0"
}
```

### Validation

- Plugin name must be lowercase, start with a letter, contain only `[a-z0-9-]`
- Version must be valid semver
- Tool names must be unique within a plugin
- Skill names must be unique within a plugin

### Helper Functions

| Function                   | Description                             |
| -------------------------- | --------------------------------------- |
| `defineBrainstormPlugin()` | Define and validate a plugin            |
| `definePluginTool()`       | Define a tool with type-safe Zod schema |
| `definePluginHook()`       | Define a lifecycle hook                 |
| `definePluginSkill()`      | Define a reusable skill                 |

---

## 15. Orchestration Pipeline

9-phase software development lifecycle in `packages/core/src/plan/orchestration-pipeline.ts`. Combines MetaGPT/ChatDev role-based pipelines, Augment Intent spec-driven coordination, and MapCoder multi-stage patterns.

### Phases

| #   | Phase              | Agent            | Subagent Type | Parallel | Description                                                       |
| --- | ------------------ | ---------------- | ------------- | -------- | ----------------------------------------------------------------- |
| 1   | **spec**           | product-manager  | plan          | No       | Write specification from user request                             |
| 2   | **architecture**   | architect        | plan          | No       | Design technical solution                                         |
| 3   | **implementation** | coder            | code          | No       | Implement the code                                                |
| 4   | **review**         | code-reviewer    | review        | Yes      | Parallel review: security-reviewer, code-reviewer, style-reviewer |
| 5   | **verify**         | build-verifier   | code          | No       | Run build and tests                                               |
| 6   | **refactor**       | refactorer       | code          | No       | Improve code quality                                              |
| 7   | **deploy**         | devops           | code          | No       | Deploy (optional, excluded from defaults)                         |
| 8   | **document**       | technical-writer | plan          | No       | Generate documentation                                            |
| 9   | **report**         | reporter         | plan          | No       | Produce execution summary                                         |

### Default Phase Set

`spec -> architecture -> implementation -> review -> verify -> refactor -> document -> report`

(Deploy is opt-in via `PipelineOptions.deploy`)

### Pipeline Features

- **Smart phase selection:** Based on kill gate evaluation (2,203 examples, 233 Claude Code sessions). Architecture/refactor/report are skippable for 33% free savings
- **Feedback loops:** Review findings can trigger loops back to implementation
- **Budget awareness:** Pipeline can be budget-limited
- **Resume capability:** Resume from any phase
- **Dry run mode:** Preview pipeline without executing
- **Custom phase selection:** Override which phases to include
- **Per-phase events:** `pipeline-started`, `phase-started`, `phase-completed`, `phase-failed`, `review-findings`, `feedback-loop`, `pipeline-completed`, `pipeline-paused`
- **Review severity levels:** critical, high, medium, low

---

## 16. Intelligence

### 16.1 Memory System (4 types)

**File-based memory** (`packages/core/src/memory/manager.ts`):

- Storage: `~/.brainstorm/projects/<project-hash>/memory/`
- Index: `MEMORY.md` (first 200 lines loaded at session start)
- Types: `user`, `project`, `feedback`, `reference`
- Gateway push: optionally pushes to cloud BrainstormRouter

**Project memory** (SQLite `project_memory` table):

- Per-project structured key/value store
- Categories: decision, convention, warning, general
- Accessible via `memory_save`, `memory_search`, `memory_list`, `memory_forget` tools

**Scratchpad** (in-session, compaction-resistant):

- Key/value notes that survive context compaction
- Via `scratchpad_write` and `scratchpad_read` tools

**BrainstormRouter cloud memory**:

- Persistent across sessions via cloud API
- Types: semantic (knowledge), episodic (events), procedural (how-to)
- Via `br_memory_search` and `br_memory_store` tools

### 16.2 Auto-Extraction Middleware

The `memory-extraction` middleware scans every assistant response for:

- **User preferences:** "always/never/prefer/don't use X" patterns
- **Project conventions:** "this project uses/requires/follows X" patterns
- **Error-fix pairs:** "fixed by/the solution is X" patterns

Extracts via regex (no LLM call). Deduplicates per session. Saves to MemoryManager.

### 16.3 Memory Consolidation (Dream)

The `/dream` command spawns a code-type subagent to:

1. Merge duplicate memory files
2. Resolve contradictions (keep most recent)
3. Convert relative dates to absolute
4. Prune stale file path references (validates with glob)
5. Trim ephemeral noise
6. Update MEMORY.md index (under 200 lines)

### 16.4 Semantic Code Search

TF-IDF based code search (`packages/core/src/search/semantic.ts`):

- Indexes project files by extracting symbols and code snippets
- Builds TF-IDF vectors with tokenization and term frequency normalization
- Cosine similarity search
- Stored in `code_embeddings` SQLite table
- Zero external dependencies (pure math, no embedding model required)

### 16.5 Context Compaction

`packages/core/src/session/compaction.ts`:

- Triggers at 80% of model's context window
- Deferred while tools are executing (prevents corrupting in-flight state)
- Token estimation: ~4 chars per token heuristic
- Preserves scratchpad notes through compaction
- Runs trajectory reduction before compaction
- Configurable: keep N recent messages, optional specific summarize model

### 16.6 Trajectory Reduction

`packages/core/src/session/trajectory-reducer.ts`:

- Prunes expired/redundant context between turns
- Reduces token usage without losing critical information
- Integrated with proactive compaction middleware

### 16.7 Session Pattern Learning

Persisted in `session_patterns` table. Tracks:

- **tool_success:** Which tools succeed for which tasks
- **command_timing:** How long commands take
- **user_preference:** Learned user preferences
- **model_choice:** Which models work best per task type

Confidence scores increase with occurrences. Used by the learned routing strategy.

### 16.8 BrainstormRouter Intelligence API

`packages/gateway/src/intelligence-api.ts` -- agent-level intelligence beyond token routing:

| Endpoint                         | Method | Description                                           |
| -------------------------------- | ------ | ----------------------------------------------------- |
| `/v1/agent/trajectory`           | POST   | Submit session trajectory for analysis and learning   |
| `/v1/agent/recommendations`      | GET    | Get routing recommendations based on project patterns |
| `/v1/agent/ensemble/rank`        | POST   | Rank candidate models for ensemble generation         |
| `/v1/intelligence/cost-forecast` | GET    | Predict task cost before executing                    |
| `/v1/community/patterns`         | POST   | Submit anonymized tool usage patterns                 |
| `/v1/community/patterns`         | GET    | Get community tool preferences for a framework        |

### 16.9 Eval System

Capability probes (`packages/eval/src/`) measure 7 dimensions:

| Dimension               | Description                            |
| ----------------------- | -------------------------------------- |
| `tool-selection`        | Chooses the right tool for the task    |
| `tool-sequencing`       | Orders tool calls logically            |
| `code-correctness`      | Generates code that compiles and works |
| `multi-step`            | Handles multi-step reasoning chains    |
| `instruction-adherence` | Follows instructions precisely         |
| `context-utilization`   | Uses available context effectively     |
| `self-correction`       | Identifies and fixes own mistakes      |

Each probe defines: setup files, prompt, verification checks (tool calls, answer content, code compilation, files modified, step count bounds, clarification requests). Results stored as JSONL with per-dimension aggregate scores forming a `CapabilityScorecard`.

### 16.10 Style and Convention Learning

The system learns project patterns through:

- Middleware auto-extraction of conventions from conversation
- Session pattern learning from tool success/failure
- Memory persistence of decisions and conventions
- Git history indexing for understanding project evolution

### 16.11 Cost Tracking and Forecasting

- **CostTracker** (`packages/router/src/cost-tracker.ts`): Per-session, per-project cost recording
- **Budget enforcement:** Daily, monthly, per-session, per-project limits with hard/soft modes
- **Forecast:** Predicts future spend based on historical patterns
- **Safety margin:** Configurable multiplier (default 1.3x) for cost estimates
- **BrainstormRouter budget API:** Real-time budget status and forecast from cloud

---

## Appendix: Package Map

| Package               | Purpose                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/shared`     | Types, errors, pino logger                                                                         |
| `packages/config`     | Zod schemas, TOML loader, layered config, BRAINSTORM.md parser                                     |
| `packages/db`         | SQLite persistence, auto-migrations                                                                |
| `packages/providers`  | Cloud + local provider connectors, auto-discovery                                                  |
| `packages/router`     | Task classifier, 6 routing strategies, CostTracker, fallback chains                                |
| `packages/tools`      | 42+ built-in tools, permission system, checkpoint/undo, Docker sandbox                             |
| `packages/core`       | Agentic loop, SessionManager, PermissionManager, compaction, memory, middleware, search, plan mode |
| `packages/agents`     | Agent profiles, NL parser, role prompts, Zod output schemas                                        |
| `packages/workflow`   | Workflow engine state machine, presets, confidence, artifact persistence                           |
| `packages/hooks`      | HookManager for lifecycle automation                                                               |
| `packages/mcp`        | MCP client with OAuth, tool normalization, SSE/HTTP/stdio transports                               |
| `packages/eval`       | Capability probes (7 dimensions), eval runner, scorer, scorecard                                   |
| `packages/gateway`    | BrainstormRouter API client, Intelligence API                                                      |
| `packages/vault`      | AES-256-GCM vault, Argon2id KDF, 1Password bridge, env fallback                                    |
| `packages/cli`        | Commander CLI + Ink TUI, 4 modes, 20+ components, role system, build wizard                        |
| `packages/plugin-sdk` | SDK for building Brainstorm plugins                                                                |
