# Configuration Guide

Brainstorm uses layered configuration: defaults → global config → project config → environment variables.

## config.toml

Global: `~/.brainstorm/config.toml`
Project: `./brainstorm.toml`

Project config overrides global config. Environment variables override both.

### Full Schema

```toml
[general]
defaultStrategy = "quality-first"  # quality-first | cost-first | combined | capability | learned | rule-based
maxSteps = 10                      # Max tool calls per turn
defaultPermissionMode = "confirm"  # auto | confirm | plan
outputStyle = "concise"            # concise | detailed | learning

[budget]
daily = 50.00                      # Daily spend limit (USD)
monthly = 500.00                   # Calendar-month spend limit
perSession = 5.00                  # Per-session limit
hardLimit = false                  # false warns; true blocks

[providers.gateway]
enabled = true
apiKeyEnv = "AI_GATEWAY_API_KEY"
baseUrl = "https://ai-gateway.vercel.sh/v1"

[providers.ollama]
enabled = true
baseUrl = "http://localhost:11434"
autoDiscover = true

[providers.lmstudio]
enabled = true
baseUrl = "http://localhost:1234"
autoDiscover = true
# Optional for a remote OpenAI-compatible endpoint. The named key is
# resolved through the vault → 1Password → environment chain.
apiKeyEnv = "CORP_MODEL_TOKEN"

[providers.lmstudio.headers]
X-Tenant = "engineering"          # Metadata only; keep secrets in apiKeyEnv

[providers.llamacpp]
enabled = false
baseUrl = "http://localhost:8080"
autoDiscover = true

[godmode.connectors.myproduct]
enabled = true
displayName = "My Product"
baseUrl = "https://myproduct.example.com"
apiKeyName = "MYPRODUCT_API_KEY"
tenantId = "tenant-123"            # Required for product execute binding; env fallback: _GM_MYPRODUCT_TENANT_ID

[[routing.rules]]                  # Rule-based routing
match = { task = "simple question" }
model = "gpt-4.1-mini"

[[routing.rules]]
match = { task = "complex refactor" }
model = "claude-sonnet-4.5"

[shell]
sandbox = "restricted"             # none | restricted | container

[shell.sandboxPool]                # Warm pool, only active when sandbox = "container"
enabled = true
maxIdlePerKey = 2                  # Max idle containers kept warm per image+workspace key
maxIdleTotal = 4                   # Max idle containers kept warm overall
idleTimeoutMs = 300000             # Idle container eviction delay (ms)

[cost]
negotiation_threshold = 0.10       # Ask user for model choice above this cost

[quality]
self_review = false                # Run cheap-model review after writes

[confirmation]
plan_preview = true                # Show plan for tasks with >3 tool calls

[community]
share_fixes = false                # Share anonymized error-fix pairs via BR

[daemon]
enabled = false                    # KAIROS always-on tick loop (`brainstorm daemon`)
tickIntervalMs = 30000             # Base tick interval; the model can extend via daemon_sleep
maxTicksPerSession = 1000          # Cost-safety ceiling per daemon session
sleepDefaultMs = 60000             # Sleep when the model doesn't specify one
reflectionIntervalTicks = 50       # Ticks between memory dream/consolidation cycles
approvalGateIntervalTicks = 0      # Ticks between human approval gates; 0 = disabled

[channels.slack]
enabled = false                    # Start the Slack adapter with `brainstorm serve`
mode = "socket"                    # socket | events-api (events-api not yet wired; rejected at startup)
appToken = ""                      # xapp-… literal, or the name of an env var to resolve
botToken = ""                      # xoxb-… literal, or the name of an env var to resolve
signingSecret = ""                 # events-api only; unused in socket mode
authority = "read-only"            # read-only | approvals | full
allowedChannels = []               # Empty = all channels the bot is in
allowedUsers = []                  # Empty = any workspace member
model = ""                         # Optional model pin for channel-initiated runs
```

`[shell.sandboxPool]` only takes effect when `shell.sandbox = "container"` — it lets Docker-backed code-subagents reuse warm containers (keyed by image + workspace) instead of cold-starting each one, with idle eviction and a drain on process exit.

`[channels.slack]` configures the Slack message adapter started by `brainstorm serve` (package `packages/channels`). It runs in Socket Mode by default (no public URL required); `authority` bounds what channel-initiated runs may do — `read-only` restricts them to an explicit read-only tool allowlist, `full` allows everything not otherwise denied.

`[daemon]` configures KAIROS, the always-on tick loop. Every tick carries a perception block (connected God Mode products, BR reachability, project state), open drift from harness world models, and unconsumed platform events (verified product events persisted by `brainstorm serve` into the `platform_events` table), plus router momentum and budget-pressure self-awareness. Tick pacing is cost-aware: as session budget is consumed the interval stretches (1.5×/2×/3×) and the daemon stops at exhaustion. `reflectionIntervalTicks` triggers the memory dream cycle; `approvalGateIntervalTicks > 0` pauses every N ticks for a human checkpoint (interactive prompt in the CLI; surfaced as a `kairos-gate` event to the desktop).

### Environment Variable Overrides

| Env Var                                       | Config Path                               | Description                                |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| `BRAINSTORM_API_KEY`                          | —                                         | BrainstormRouter API key                   |
| `BRAINSTORM_STRATEGY`                         | `general.defaultStrategy`                 | Override default strategy                  |
| `BRAINSTORM_MAX_STEPS`                        | `general.maxSteps`                        | Override max tool calls                    |
| `BRAINSTORM_BUDGET`                           | `budget.dailyLimit`                       | Override daily budget                      |
| `BRAINSTORM_PERMISSION_MODE`                  | `general.permissionMode`                  | Override permission mode                   |
| `_GM_<CONNECTOR>_TENANT_ID`                   | `godmode.connectors.<connector>.tenantId` | Product execute tenant binding             |
| `BRAINSTORM_TENANT_ID` / `PLATFORM_TENANT_ID` | fallback tenant binding                   | Last-resort product execute tenant binding |

## BRAINSTORM.md

Project-level context file, placed at the project root. Similar to CLAUDE.md but for Brainstorm.

### Format

```markdown
---
build_command: npm run build
test_command: npm test
language: typescript
framework: next
lint_command: npx eslint --fix
---

# Project Name

Project description and conventions for the AI assistant.

## Conventions

- Use Drizzle ORM for database queries
- All components go in src/components/
- Tests use vitest
```

### Frontmatter Fields

| Field           | Type   | Description                                   |
| --------------- | ------ | --------------------------------------------- |
| `build_command` | string | Command to build the project                  |
| `test_command`  | string | Command to run tests                          |
| `language`      | string | Primary language (typescript, python, etc.)   |
| `framework`     | string | Framework in use (next, react, fastapi, etc.) |
| `lint_command`  | string | Linter command for auto-lint hook             |

### Hierarchical Loading

BRAINSTORM.md files are loaded hierarchically — a monorepo can have a root BRAINSTORM.md and per-package BRAINSTORM.md files. Child files inherit and override parent settings.

## Database

SQLite database at `~/.brainstorm/brainstorm.db` (WAL mode). Stores:

- Sessions and conversation messages
- Cost records per request
- Agent profiles
- Workflow run history
- Eval results and scorecards
- Session patterns (cross-session learning)

## Vault

API keys can be stored in the encrypted vault:

```bash
storm vault add BRAINSTORM_API_KEY       # Add a key
storm vault list                         # List stored keys
storm vault status                       # Check vault health
```

Keys are resolved in order: vault → 1Password → environment variables.
