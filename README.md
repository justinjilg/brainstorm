# Brainstorm

An open-source AI coding assistant with intelligent model routing. Routes tasks to the optimal model across 357+ models and 7 providers via [BrainstormRouter](https://brainstormrouter.com).

```bash
npm install -g @brainstorm/cli
storm chat
```

## What Makes Brainstorm Different

**Intelligent routing.** Every other CLI sends all requests to one model. Brainstorm routes each task to the best model for that specific job — complex code to Claude Sonnet, quick reads to GPT-4.1-mini, reasoning tasks to o3 — powered by real production performance data from BrainstormRouter.

**Gateway intelligence.** Native tools to query your AI gateway: check budget (`br_budget`), view model rankings (`br_leaderboard`), search persistent memory (`br_memory_search`), get cost optimization insights (`br_insights`). The agent knows its own infrastructure.

**32 built-in tools.** Filesystem (8), shell (3), git (6), GitHub (2), web (2), tasks (3), BrainstormRouter intelligence (8). Every tool returns consistent `{ ok, data, error }` format.

**Multi-model, multi-provider.** Works with Anthropic, OpenAI, Google, DeepSeek, xAI, Mistral — plus local models via Ollama, LM Studio, and llama.cpp. Switch models mid-session with `/model`.

## Quick Start

```bash
# Install
npm install -g @brainstorm/cli

# Set up your BrainstormRouter API key (free tier available)
storm vault add BRAINSTORM_API_KEY

# Start coding
storm chat

# Or run a single prompt
storm run --tools "Create a React component for user authentication"

# Full auto mode (skip confirmations)
storm run --tools --lfg "Read the codebase and fix the failing tests"
```

## Architecture

Turborepo monorepo with 15 TypeScript packages:

```
packages/
├── cli         Command-line interface (Commander + Ink TUI)
├── core        Agent loop, session management, context, permissions
├── router      Task classifier, 6 routing strategies, cost tracking
├── providers   AI Gateway + local model discovery (Ollama, LM Studio)
├── tools       32 built-in tools with Zod schemas
├── shared      Types, errors, logging (pino)
├── config      TOML config, Zod schemas, BRAINSTORM.md parser
├── db          SQLite persistence (sessions, costs, agent profiles)
├── agents      Agent profiles, subagent system (5 types, parallel)
├── workflow    Workflow engine, preset workflows
├── hooks       Lifecycle hooks (PreToolUse, PostToolUse, etc.)
├── mcp         MCP client for external tool integration
├── eval        Capability probes, eval runner, scorecard
├── gateway     BrainstormRouter API client, header parsing
└── vault       Encrypted key store (AES-256-GCM + Argon2id)
```

## Routing Strategies

| Strategy | When To Use |
|----------|------------|
| `quality-first` | Paid keys (default). Best model for the task. |
| `cost-first` | Budget-constrained. Cheapest viable model. |
| `capability` | Eval data available. Routes by measured capability scores. |
| `combined` | Balances quality, cost, and speed. |
| `rule-based` | Custom rules in config.toml. |

## Configuration

```toml
# ~/.brainstorm/config.toml
[general]
defaultStrategy = "quality-first"
maxSteps = 10

[budget]
dailyLimit = 50.00

[providers.ollama]
enabled = true
baseUrl = "http://localhost:11434"
```

Project-level context via `BRAINSTORM.md`:

```markdown
---
build_command: npm run build
test_command: npm test
---

# My Project

Description and conventions for the AI assistant.
```

## BrainstormRouter Integration

Brainstorm ships with native tools for querying [BrainstormRouter](https://brainstormrouter.com):

| Tool | Purpose |
|------|---------|
| `br_status` | Full system check: identity, budget, health, suggestions |
| `br_budget` | Budget status + spend forecast |
| `br_leaderboard` | Real model performance rankings |
| `br_insights` | Cost optimization recommendations |
| `br_models` | Available models with pricing |
| `br_memory_search` | Search persistent memory across sessions |
| `br_memory_store` | Save facts that persist across sessions |
| `br_health` | Quick connectivity test |

## Development

```bash
git clone https://github.com/justinjilg/brainstorm.git
cd brainstorm
npm install
npx turbo run build        # Build all packages
npx turbo run test         # Run tests
node packages/cli/dist/brainstorm.js chat  # Run locally
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[Apache License 2.0](LICENSE)
