# Brainstorm LLM Operator Guide

Machine-readable reference for AI agents operating the Brainstorm CLI. Every claim verified against source code as of v0.13.0.

## Identity

Brainstorm is a governed control plane that connects AI operators to infrastructure through 45 built-in tools and ~100 runtime-discovered tools across 5 products. It routes prompts to the optimal LLM via Thompson sampling, enforces cost budgets, and requires approval for destructive actions via ChangeSets.

## Quick Start

```bash
npm install -g @brainst0rm/cli    # Install
brainstorm setup                   # Configure auth + MCP
brainstorm status                  # Verify connectivity
brainstorm introspect              # Machine-readable capabilities (JSON)
brainstorm run --json "prompt"     # Non-interactive single prompt
```

## CLI Contract

### Commands

| Command                       | Purpose                          | `--json`    |
| ----------------------------- | -------------------------------- | ----------- |
| `brainstorm run [prompt]`     | Non-interactive single prompt    | Yes         |
| `brainstorm chat`             | Interactive TUI session          | No          |
| `brainstorm introspect`       | Dump capabilities as JSON        | Always JSON |
| `brainstorm status`           | Ecosystem health check           | Yes         |
| `brainstorm models`           | List available models            | Yes         |
| `brainstorm config`           | Show configuration               | Yes         |
| `brainstorm budget`           | Cost tracking                    | Yes         |
| `brainstorm mcp`              | MCP server (stdio transport)     | N/A         |
| `brainstorm serve`            | HTTP API server                  | N/A         |
| `brainstorm setup`            | Configure auth + MCP             | No          |
| `brainstorm vault`            | Manage encrypted key storage     | No          |
| `brainstorm eval`             | Run capability probes            | Yes         |
| `brainstorm agent`            | Manage named agents              | No          |
| `brainstorm workflow`         | Multi-agent workflows            | No          |
| `brainstorm spawn <task>`     | Background agent in git worktree | No          |
| `brainstorm storm <tasks...>` | Parallel task execution          | No          |
| `brainstorm analyze [path]`   | Codebase analysis                | No          |
| `brainstorm docgen [path]`    | Generate documentation           | No          |

### Non-Interactive Mode (`brainstorm run`)

**Input:**

```bash
brainstorm run "your prompt"                    # Positional argument
brainstorm run --pipe                           # Read from stdin
echo "prompt" | brainstorm run --pipe           # Piped input
brainstorm run "base prompt" --pipe             # Argument + stdin appended
```

**Flags:**

| Flag                | Effect                                                            |
| ------------------- | ----------------------------------------------------------------- |
| `--json`            | Output structured JSON on stdout only (progress on stderr)        |
| `--pipe`            | Read prompt from stdin                                            |
| `--model <id>`      | Target specific model (bypass routing)                            |
| `--tools`           | Enable tool use (disabled by default)                             |
| `--max-steps <n>`   | Maximum agentic steps (default: 1)                                |
| `--strategy <name>` | Routing strategy: cost-first, quality-first, combined, capability |
| `--lfg`             | Full auto mode — skip all permission confirmations                |
| `--unattended`      | Enable tools + auto-approve + auto-commit                         |

**Output (`--json`):**

```json
{
  "text": "response content",
  "model": "claude-opus-4-6",
  "cost": 0.0042,
  "toolCalls": 3,
  "success": true
}
```

**Error output (`--json`):**

```json
{
  "text": "",
  "model": "",
  "cost": 0,
  "toolCalls": 0,
  "error": "error message",
  "success": false
}
```

**Exit codes:**

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | Success                                         |
| 1    | Error (LLM error, missing prompt, tool failure) |

### Automation Flags

| Flag              | What it enables                                                        |
| ----------------- | ---------------------------------------------------------------------- |
| `--tools`         | Tool use in non-interactive mode (default: off)                        |
| `--lfg`           | Skip all permission prompts — auto-approve everything                  |
| `--unattended`    | Combines `--tools` + `--lfg` + auto-commit                             |
| `--max-steps <n>` | Cap agentic loop iterations (default: 1, set higher for complex tasks) |

**Recommended headless invocation:**

```bash
brainstorm run --json --tools --lfg --max-steps 15 "your prompt"
```

## Tool Reference

### Static Tools (45 built-in)

Full schemas: [`docs/tool-catalog.json`](tool-catalog.json)

| Category                  | Tools                                                                                                      | Permission                     | Readonly   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------- |
| **filesystem** (8)        | file_read, file_write, file_edit, multi_edit, batch_edit, list_dir, glob, grep                             | auto (reads), confirm (writes) | reads: yes |
| **shell** (4)             | shell, process_spawn, process_kill, build_verify                                                           | confirm                        | no         |
| **git** (6)               | git_status, git_diff, git_log, git_commit, git_branch, git_stash                                           | auto (reads), confirm (writes) | reads: yes |
| **github** (2)            | gh_pr, gh_issue                                                                                            | confirm                        | no         |
| **web** (2)               | web_fetch, web_search                                                                                      | confirm                        | no         |
| **tasks** (3)             | task_create, task_update, task_list                                                                        | auto                           | mixed      |
| **agent** (6)             | undo_last_write, ask_user, scratchpad_read, scratchpad_write, set_routing_hint, cost_estimate              | auto                           | mixed      |
| **transactions** (3)      | begin_transaction, commit_transaction, rollback_transaction                                                | confirm                        | no         |
| **brainstorm_router** (8) | br_status, br_budget, br_models, br_memory_search, br_memory_store, br_leaderboard, br_insights, br_health | auto                           | mixed      |
| **planning** (1)          | plan_preview                                                                                               | auto                           | yes        |
| **discovery** (1)         | tool_search                                                                                                | auto                           | yes        |
| **daemon** (1)            | daemon_sleep                                                                                               | auto                           | no         |

### Runtime Tools (discovered at startup)

Runtime tools are not in `tool-catalog.json` — they depend on which products and MCP servers are reachable.

| Source                | Discovery method                                 | Typical count |
| --------------------- | ------------------------------------------------ | ------------- |
| **God Mode (MSP)**    | `GET /api/v1/god-mode/tools` on BrainstormMSP    | ~79 tools     |
| **God Mode (BR)**     | `GET /api/v1/god-mode/tools` on BrainstormRouter | ~10 tools     |
| **God Mode (others)** | Same endpoint on GTM, VM, Shield                 | ~9 each       |
| **MCP servers**       | Configured in `~/.brainstorm/mcp.json`           | varies        |

**Important:** God Mode tools are **deferred** in the MCP server. They don't appear in the initial tool list. Call `tool_search` with a keyword to discover and load them.

### Error Contract

```
Success: Tool returns a domain-specific object
         e.g., file_read → { content: string, totalLines: number }
         e.g., git_status → { output: string }

Failure: Tool returns { error: string }
         e.g., { error: "File not found: /path" }

Detection: Check for the presence of an 'error' key in the result.
           There is NO unified { ok, data, error } wrapper.
```

### Permission Model

| Level     | Behavior                   | In `--lfg` mode           |
| --------- | -------------------------- | ------------------------- |
| `auto`    | Runs without confirmation  | Runs without confirmation |
| `confirm` | Blocks until user approves | Auto-approved             |
| `deny`    | Blocked entirely           | Still blocked             |

### Multi-Step Protocols

**Transactions:**

```
begin_transaction → file_write / file_edit (staged) → commit_transaction
                                                    → rollback_transaction (discard)
```

**ChangeSets (God Mode):**

```
Destructive tool call → returns ChangeSet (simulation + risk score)
Present to user → gm_changeset_approve or gm_changeset_reject
```

**Deferred tool discovery:**

```
tool_search({ query: "deploy" }) → loads matching MCP/God Mode tools → tools become callable
```

## MCP Server

### Spawning

```bash
brainstorm mcp    # Starts MCP server on stdio
```

Config location: `~/.claude/mcp.json` (Claude Code auto-discovers)

```json
{
  "brainstorm": {
    "command": "brainstorm",
    "args": ["mcp"]
  }
}
```

### Deferred Tool Discovery

The MCP server registers built-in tools immediately. God Mode tools from connected products are **deferred** — they exist but aren't sent to the LLM until `tool_search` resolves them. This is intentional to conserve context window space.

**To discover runtime tools:** Call `tool_search` with a keyword related to what you need.

## Configuration

### File Locations

| Scope           | Path                                                     | Format                         |
| --------------- | -------------------------------------------------------- | ------------------------------ |
| Global          | `~/.brainstorm/config.toml`                              | TOML                           |
| Project         | `./brainstorm.toml`                                      | TOML                           |
| Env overrides   | `BRAINSTORM_DEFAULT_STRATEGY`, `BRAINSTORM_BUDGET_DAILY` | Env var                        |
| MCP servers     | `~/.brainstorm/mcp.json` + `./.brainstorm/mcp.json`      | JSON                           |
| Project context | `./BRAINSTORM.md`                                        | Markdown with YAML frontmatter |

### Key Settings

Verified against `packages/config/src/schema.ts`:

| Key                             | Type    | Default                             | Description                          |
| ------------------------------- | ------- | ----------------------------------- | ------------------------------------ |
| `general.defaultStrategy`       | string  | `"combined"`                        | Routing strategy                     |
| `general.maxSteps`              | number  | `10`                                | Max agentic steps per turn           |
| `general.defaultPermissionMode` | enum    | `"confirm"`                         | auto, confirm, plan                  |
| `budget.daily`                  | number  | —                                   | Daily cost limit (USD)               |
| `budget.monthly`                | number  | —                                   | Monthly cost limit (USD)             |
| `budget.hardLimit`              | boolean | `false`                             | Block requests over budget (vs warn) |
| `shell.sandbox`                 | enum    | `"restricted"`                      | none, restricted, container          |
| `shell.defaultTimeout`          | number  | `120000`                            | Shell command timeout (ms)           |
| `providers.gateway.baseUrl`     | string  | `"https://ai-gateway.vercel.sh/v1"` | AI gateway endpoint                  |
| `providers.ollama.baseUrl`      | string  | `"http://localhost:11434"`          | Ollama endpoint                      |

### Querying

```bash
brainstorm config --json        # Current resolved configuration
brainstorm introspect           # Full capabilities + auth + config
```

## God Mode

### Product Discovery

On startup, brainstorm:

1. Health-checks each configured product (`GET /health`)
2. Fetches tool definitions (`GET /api/v1/god-mode/tools`)
3. Converts JSONSchema → Zod and registers tools
4. Injects product capabilities into system prompt

### ChangeSet Protocol

Every destructive God Mode action:

1. Returns a **ChangeSet** with simulation, risk score, and cascading effects
2. Operator presents the ChangeSet to the user
3. User approves → `gm_changeset_approve` executes the action
4. User rejects → `gm_changeset_reject` discards it
5. All actions logged to tamper-evident audit trail

### Connected Products

| Product          | Base URL                 | What it manages                                  |
| ---------------- | ------------------------ | ------------------------------------------------ |
| BrainstormMSP    | brainstormmsp.ai         | Endpoints, users, backup, discovery, edge agents |
| BrainstormRouter | api.brainstormrouter.com | AI model routing, cost tracking, memory          |
| BrainstormGTM    | catsfeet.com             | Marketing automation, campaigns, leads           |
| BrainstormVM     | vm.brainstorm.co         | Virtual machines, storage, networking            |
| BrainstormShield | shield.brainstorm.co     | Email security, threat scanning, quarantine      |

## Routing

### Strategies

| Strategy        | When to use                             | Tradeoff                       |
| --------------- | --------------------------------------- | ------------------------------ |
| `quality-first` | Complex reasoning, code generation      | Higher cost                    |
| `cost-first`    | Simple queries, high volume             | Lower quality                  |
| `combined`      | General use (default)                   | Balanced                       |
| `capability`    | Tasks requiring specific model features | Feature-driven                 |
| `learned`       | After sufficient usage data             | Thompson sampling optimization |

### Model Selection

Brainstorm profiles each task (complexity, language, domain) and matches to models via the selected strategy. Override with `--model <id>`.

### Cost Tracking

Budget enforcement is per-session, daily, and monthly. Use `cost_estimate` tool before expensive operations. Query with `brainstorm budget --json`.

## Error Contract

### Tool Errors

```json
{ "error": "File not found: /path/to/file" }
```

Check for `error` key. No wrapper object.

### CLI Errors (`--json` mode)

```json
{
  "text": "",
  "model": "",
  "cost": 0,
  "toolCalls": 0,
  "error": "No prompt provided",
  "success": false
}
```

Exit code: 1.

### HTTP/API Errors (God Mode, BR)

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "Missing required field: device_id"
  }
}
```

Common codes: `VALIDATION`, `UNAUTHORIZED`, `RATE_LIMITED`, `NOT_FOUND`, `INTERNAL`.

## Auth & Bootstrap

### Key Resolution Order

1. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
2. 1Password vault (`op read "op://Dev Keys/..."` if `OP_SERVICE_ACCOUNT_TOKEN` set)
3. Local vault (`~/.brainstorm/vault` — AES-256-GCM encrypted)

### Required Keys

| Key                      | What it unlocks                                 | How to get                     |
| ------------------------ | ----------------------------------------------- | ------------------------------ |
| `BRAINSTORM_API_KEY`     | BrainstormRouter (model routing, all providers) | brainstormrouter.com/dashboard |
| `ANTHROPIC_API_KEY`      | Direct Anthropic access (fallback)              | console.anthropic.com          |
| `BRAINSTORM_MSP_API_KEY` | God Mode MSP tools                              | BrainstormMSP dashboard        |

### Verifying Auth

```bash
brainstorm status --json    # Shows which providers/products are reachable
brainstorm introspect       # auth section shows resolved key status
```

## Headless Safety

### Safe Tools (no `--lfg` needed)

All tools with `permission: "auto"` work in `brainstorm run` without `--lfg`. This includes: file*read, glob, grep, list_dir, git_status, git_diff, git_log, task*\_, scratchpad\_\_, br\_\*, tool_search, cost_estimate.

### Unsafe Tools

| Tool                       | Issue                                                           | Mitigation                     |
| -------------------------- | --------------------------------------------------------------- | ------------------------------ |
| `ask_user`                 | Blocks waiting for UI event. **Deadlocks** in `brainstorm run`. | Only use in `brainstorm chat`. |
| `confirm`-permission tools | Block waiting for user approval.                                | Use `--lfg` flag.              |

### Recommended Invocation

```bash
# Safe: read-only, no approval needed
brainstorm run --json "list files in src/"

# Agentic: tools enabled, auto-approve, bounded steps
brainstorm run --json --tools --lfg --max-steps 15 "refactor auth module"

# Full auto: tools + auto-commit + no prompts
brainstorm run --json --unattended --max-steps 20 "fix the failing test"
```

## Appendix

### Environment Variables

| Variable                       | Purpose                   |
| ------------------------------ | ------------------------- |
| `BRAINSTORM_API_KEY`           | BrainstormRouter API key  |
| `ANTHROPIC_API_KEY`            | Anthropic API key         |
| `OPENAI_API_KEY`               | OpenAI API key            |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI API key         |
| `BRAINSTORM_MSP_API_KEY`       | MSP God Mode access       |
| `BRAINSTORM_DEFAULT_STRATEGY`  | Override routing strategy |
| `BRAINSTORM_BUDGET_DAILY`      | Override daily budget     |
| `OP_SERVICE_ACCOUNT_TOKEN`     | 1Password vault access    |

### Current Model Names

| Model             | ID                          | Provider  |
| ----------------- | --------------------------- | --------- |
| Claude Opus 4.6   | `claude-opus-4-6`           | Anthropic |
| Claude Sonnet 4.6 | `claude-sonnet-4-6`         | Anthropic |
| Claude Haiku 4.5  | `claude-haiku-4-5-20251001` | Anthropic |
| GPT-5.4           | `gpt-5.4`                   | OpenAI    |
| Gemini 3.1 Pro    | `gemini-3.1-pro-preview`    | Google    |
| Gemini 2.5 Flash  | `gemini-2.5-flash`          | Google    |

### Related Files

- Tool catalog (JSON Schema): [`docs/tool-catalog.json`](tool-catalog.json)
- Platform contract: [`docs/platform-contract-v1.md`](platform-contract-v1.md)
- Config guide: [`docs/config-guide.md`](config-guide.md)
- Architecture: [`docs/architecture.md`](architecture.md)
