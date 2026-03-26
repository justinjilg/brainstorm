# Brainstorm

[![Build](https://github.com/justinjilg/brainstorm/actions/workflows/ci.yml/badge.svg)](https://github.com/justinjilg/brainstorm/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

An open-source AI coding assistant with intelligent model routing. Routes tasks to the optimal model across 357+ models and 7 providers via [BrainstormRouter](https://brainstormrouter.com).

```bash
npm install -g @brainstorm/cli
storm chat
```

## What Makes Brainstorm Different

**Intelligent routing.** Every other CLI sends all requests to one model. Brainstorm routes each task to the best model for that specific job — complex code to Claude Sonnet, quick reads to GPT-4.1-mini, reasoning tasks to o3 — powered by real production performance data from BrainstormRouter.

**Self-aware agent.** Brainstorm knows what model it's using, how much it's spent, which tools are healthy, whether the build is passing, and what files it has touched. This context is injected every turn so the agent makes better decisions.

**42 built-in tools.** Filesystem (8), shell (3), git (6), GitHub (2), web (2), tasks (3), agent (6), planning (1), transactions (3), BrainstormRouter intelligence (8). Every tool returns consistent `{ ok, data, error }` format.

**Multi-model, multi-provider.** Works with Anthropic, OpenAI, Google, DeepSeek, xAI, Mistral — plus local models via Ollama, LM Studio, and llama.cpp. Switch models mid-session with `/model`.

**Plugin system.** Extend Brainstorm with custom tools, hooks, and skills via the Plugin SDK.

## Features

| Category | Features |
|----------|---------|
| **Routing** | 5 strategies (quality, cost, combined, capability, rule-based), fallback chains, cost tracking |
| **Tools** | 42 built-in, pre-validation, checkpoint/undo, transactions, diff preview |
| **Intelligence** | Turn context, file tracking, tool health, build state, loop detection, sentiment analysis |
| **Learning** | Cross-session patterns, error-fix pairs, reaction tracking |
| **Context** | Scratchpad (compaction-resistant), hierarchical BRAINSTORM.md, compaction warnings |
| **Security** | Encrypted vault (AES-256-GCM), permission modes, path guard, credential scanner |
| **Extensibility** | Plugin SDK, lifecycle hooks, MCP client, skills system, subagents |

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

See [Getting Started](docs/getting-started.md) for the full tutorial.

## Architecture

Turborepo monorepo with 16 TypeScript packages:

```
packages/
├── cli          Command-line interface (Commander + Ink TUI)
├── core         Agent loop, session management, context, permissions
├── router       Task classifier, 5 routing strategies, cost tracking
├── providers    AI Gateway + local model discovery (Ollama, LM Studio)
├── tools        42 built-in tools with Zod schemas
├── shared       Types, errors, logging (pino)
├── config       TOML config, Zod schemas, BRAINSTORM.md parser
├── db           SQLite persistence (sessions, costs, patterns)
├── agents       Agent profiles, subagent system (5 types, parallel)
├── workflow     Workflow engine, preset workflows
├── hooks        Lifecycle hooks (PreToolUse, PostToolUse, etc.)
├── mcp          MCP client for external tool integration
├── eval         Capability probes, eval runner, scorecard
├── gateway      BrainstormRouter API client, header parsing
├── vault        Encrypted key store (AES-256-GCM + Argon2id)
└── plugin-sdk   SDK for building Brainstorm plugins
```

See [Architecture Guide](docs/architecture.md) for the full dependency graph and data flow.

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

See [Configuration Guide](docs/config-guide.md) for the full schema.

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

See [BrainstormRouter Integration](docs/brainstormrouter-integration.md) for API details.

## Documentation

| Document | Description |
|----------|------------|
| [Getting Started](docs/getting-started.md) | 5-minute setup and first session |
| [Architecture](docs/architecture.md) | Package graph, data flow, intelligence features |
| [Tools Reference](docs/tools.md) | All 42 tools with descriptions and permissions |
| [Configuration Guide](docs/config-guide.md) | config.toml, BRAINSTORM.md, environment variables |
| [BrainstormRouter](docs/brainstormrouter-integration.md) | API endpoints, headers, error recovery |
| [Plugin Development](docs/plugin-development.md) | Build custom tools, hooks, and skills |

## Development

```bash
git clone https://github.com/justinjilg/brainstorm.git
cd brainstorm
npm install
npx turbo run build        # Build all 16 packages
npx turbo run test         # Run tests
node packages/cli/dist/brainstorm.js chat  # Run locally
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[Apache License 2.0](LICENSE)
