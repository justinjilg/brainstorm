# Configuration Guide

Brainstorm uses layered configuration: defaults → global config → project config → environment variables.

## config.toml

Global: `~/.brainstorm/config.toml`
Project: `./brainstorm.toml`

Project config overrides global config. Environment variables override both.

### Full Schema

```toml
[general]
defaultStrategy = "quality-first"  # quality-first | cost-first | combined | capability | rule-based
maxSteps = 10                      # Max tool calls per turn
contextWindow = 128000             # Context window size (tokens)
compactionThreshold = 0.8          # Compact at this % of context window
permissionMode = "normal"          # strict | normal | permissive
outputStyle = "concise"            # concise | detailed | learning | explanatory

[budget]
dailyLimit = 50.00                 # Daily spend limit (USD)
sessionLimit = 5.00                # Per-session limit
warningThreshold = 0.8             # Warn at this % of budget

[providers.brainstormrouter]
enabled = true
baseUrl = "https://api.brainstormrouter.com/v1"

[providers.ollama]
enabled = true
baseUrl = "http://localhost:11434"

[providers.lmstudio]
enabled = true
baseUrl = "http://localhost:1234"

[providers.llamacpp]
enabled = false
baseUrl = "http://localhost:8080"

# Any OpenAI-compatible endpoint (corporate LLM gateway, vLLM, LiteLLM proxy).
# The name ("mygateway") becomes the model-id prefix: "mygateway:<model>".
# Bearer token comes from apiKeyEnv (env var name) or apiKeyFile (path, "~/" ok);
# omit both for unauthenticated endpoints. If the endpoint uses a private CA,
# start brainstorm with NODE_EXTRA_CA_CERTS=/path/to/ca.pem.
[providers.custom.mygateway]
enabled = true
baseUrl = "https://llm.example.internal"
apiKeyEnv = "MYGATEWAY_API_KEY"
# apiKeyFile = "~/.mygateway_key"

[providers.anthropic]
enabled = false                    # Direct Anthropic (bypass BrainstormRouter)

[providers.openai]
enabled = false                    # Direct OpenAI (bypass BrainstormRouter)

[godmode.connectors.myproduct]
enabled = true
displayName = "My Product"
baseUrl = "https://myproduct.example.com"
apiKeyName = "MYPRODUCT_API_KEY"
tenantId = "tenant-123"            # Required for product execute binding; env fallback: _GM_MYPRODUCT_TENANT_ID

[routing]
preferLocal = false                # Prefer local models when available
fallbackToCloud = true             # Fall back to cloud if local fails

[[routing.rules]]                  # Rule-based routing
pattern = "simple question"
model = "gpt-4.1-mini"

[[routing.rules]]
pattern = "complex refactor"
model = "claude-sonnet-4.5"

[hooks]
auto_lint = false                  # Run linter after file writes

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
