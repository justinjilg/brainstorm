# Brainstorm

[![Build](https://github.com/justinjilg/brainstorm/actions/workflows/ci.yml/badge.svg)](https://github.com/justinjilg/brainstorm/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![PRs](https://img.shields.io/badge/PRs-268-brightgreen.svg)](https://github.com/justinjilg/brainstorm/pulls?q=is%3Amerged)

An open-source, multi-model AI coding assistant with a 4-mode terminal dashboard. Routes tasks across 10+ models and 8 providers via [BrainstormRouter](https://brainstormrouter.com). Like Claude Code, but with model choice.

```bash
npm install -g @brainstorm/cli
storm chat
```

## Terminal Dashboard

Brainstorm runs in a multi-mode TUI with 4 views switchable via Esc and number keys:

**[1] Chat** — Conversation with streaming markdown, syntax-highlighted code blocks, tool call tracking with spinners and duration, and interactive model selection via the `ask_user` tool.

**[2] Dashboard** — Live mission control: session cost, tokens, $/hour, routing decision log, tool health gauges, plus BrainstormRouter data (model leaderboard, waste detection, guardian audit, budget forecast, 7-day cost trend).

**[3] Models** — Interactive model explorer with arrow-key navigation. Shows all models with provider-colored names, quality/speed gauges, pricing, and status. Enter selects a model for the session.

**[4] Config** — Active configuration, vault status (locked/unlocked), resolved API keys with provider labels, memory entry counts, and a quick reference for all commands.

## What Makes Brainstorm Different

**Multi-model routing.** Every other CLI locks you to one model. Brainstorm routes each task to the optimal model — architecture to Opus, coding to Sonnet, quick edits to Haiku — with 6 routing strategies and automatic fallback chains.

**Role-based workflows.** Switch your assistant's personality with `/architect`, `/sr-developer`, `/jr-developer`, `/qa`, or `/product-manager`. Each role configures the model, system prompt, tools, output style, and routing strategy in one command.

**Build wizard.** `/build add OAuth login` auto-detects the workflow type, assigns models per pipeline step (architect → coder → reviewer), shows cost estimates, and executes. Customize any step's model with `/build-set 1 2`.

**Interactive selection.** The model can ask you to pick from options — just like Claude Code's AskUserQuestion. Arrow keys to navigate, Enter to select, descriptions shown on hover.

**Slash command autocomplete.** Type `/` and suggestions appear filtered as you type. Tab/Enter accepts.

**Self-aware agent.** Every turn, the agent knows: which model, how much spent, budget remaining, files touched, build status, tool health, and routing history. This context injection makes the agent dramatically more effective.

## Features

| Category             | What's Included                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TUI**              | 4-mode dashboard, syntax highlighting (cli-highlight), streaming markdown, tool tracking with ✓/✗ + duration, scrollable messages, provider-colored model names, Catppuccin theme |
| **Routing**          | 6 strategies (quality, cost, combined, capability, rule-based, learned/Thompson sampling), cost-aware subagent routing, budget forecast                                           |
| **Roles**            | 5 preset roles with curated model menus, custom system prompts, one-command activation                                                                                            |
| **Build**            | Multi-model workflow wizard, per-step model assignment, cost estimation, 4 preset workflows                                                                                       |
| **Tools**            | 42+ built-in (filesystem, shell, git, GitHub, web, tasks, agents, planning, transactions), checkpoint/undo, diff preview                                                          |
| **Intelligence**     | Turn context injection, semantic code search (TF-IDF), git history indexing, proactive compaction, style learning, memory extraction                                              |
| **Learning**         | Cross-session patterns, error-fix pairs, Thompson sampling from outcomes, auto-routing feedback to BrainstormRouter                                                               |
| **Security**         | Encrypted vault (AES-256-GCM + Argon2id), 1Password integration, permission modes (auto/confirm/plan), Docker sandbox, RBAC roles                                                 |
| **BrainstormRouter** | Model leaderboard, waste detection, guardian audit, budget forecast, cost trends, routing recommendations, community patterns                                                     |
| **Extensibility**    | Plugin SDK, lifecycle hooks (10 middleware), MCP client with OAuth, skills system, 7 subagent types                                                                               |

## Quick Start

```bash
# Install
npm install -g @brainstorm/cli

# Add your API key (stored in encrypted vault)
storm vault add MOONSHOT_API_KEY    # or DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, etc.

# Start coding
storm chat

# Key shortcuts
# Esc          → Dashboard mode
# Shift+Tab    → Cycle permission mode (auto/confirm/plan)
# /help        → Command reference
# /build desc  → Multi-model workflow wizard
# /architect 1 → Switch to architect role with Opus
# ?            → Full shortcut overlay (in non-chat modes)
```

## Slash Commands

| Command             | Description                                        |
| ------------------- | -------------------------------------------------- |
| `/help [cmd]`       | Grouped command reference or per-command detail    |
| `/model [name]`     | Switch model mid-session                           |
| `/architect [N]`    | Architect role (Opus default, read-only, detailed) |
| `/sr-developer [N]` | Senior dev (Sonnet default, full tools, concise)   |
| `/jr-developer [N]` | Junior dev (Haiku default, cost-first, fast)       |
| `/qa [N]`           | QA engineer (Sonnet default, testing focus)        |
| `/build [desc]`     | Multi-model workflow wizard                        |
| `/context`          | Token breakdown with visual gauge                  |
| `/insights`         | Session intelligence + BR optimization tips        |
| `/recommend`        | Get model recommendation from BrainstormRouter     |
| `/stats`            | Session analytics + BR daily usage                 |
| `/compact [focus]`  | Compact context with optional focus instruction    |
| `/undo`             | Remove last user message + response                |
| `/changelog`        | What's new across versions                         |
| `/role`             | Show current role or list all                      |
| `/default`          | Reset to default session state                     |

## Architecture

Turborepo monorepo with 16 TypeScript packages:

```
packages/
├── cli          Commander + Ink TUI (React for terminal), 4 modes, 20+ components
├── core         Agent loop, session management, context, permissions, 10 middleware
├── router       Task classifier, 6 routing strategies, Thompson sampling, cost tracking
├── providers    Cloud (8 providers) + local (Ollama, LM Studio, llama.cpp) discovery
├── tools        42+ tools with Zod schemas, checkpoint/undo, Docker sandbox
├── shared       Types, errors, telemetry, logging (pino)
├── config       TOML config, Zod schemas, BRAINSTORM.md parser
├── db           SQLite persistence (sessions, costs, patterns, audit log, embeddings)
├── agents       Agent profiles, NL parser, 7 subagent types (explore, plan, code, review, decompose, external, general)
├── workflow     Workflow engine, 4 presets, artifact persistence, confidence escalation
├── hooks        Lifecycle hooks (PreToolUse, PostToolUse, SessionStart, etc.)
├── mcp          MCP client with OAuth, tool normalization, SSE/HTTP/stdio transports
├── eval         Capability probes (7 dimensions), eval runner, scorecard
├── gateway      BrainstormRouter API client, intelligence API, header parsing
├── vault        Encrypted key store (AES-256-GCM + Argon2id), 1Password bridge
└── plugin-sdk   SDK for building Brainstorm plugins
```

## Cloud Models

| Model             | Provider  | Quality | Speed  | Cost (in/out per 1M) |
| ----------------- | --------- | ------- | ------ | -------------------- |
| Claude Opus 4.6   | Anthropic | ★★★     | ⚡     | $15/$75              |
| Claude Sonnet 4.6 | Anthropic | ★★★     | ⚡⚡   | $3/$15               |
| Claude Haiku 4.5  | Anthropic | ★       | ⚡⚡⚡ | $0.80/$4             |
| GPT-5.4           | OpenAI    | ★★★     | ⚡⚡   | $2.50/$10            |
| Gemini 3.1 Pro    | Google    | ★★★     | ⚡⚡   | $1.25/$5             |
| Gemini 3.1 Flash  | Google    | ★★      | ⚡⚡⚡ | $0.15/$0.60          |
| Kimi K2.5         | Moonshot  | ★★★     | ⚡⚡   | $0.60/$2.40          |
| DeepSeek V3       | DeepSeek  | ★★      | ⚡⚡   | $0.27/$1.10          |
| o3-mini           | OpenAI    | ★★      | ⚡⚡   | $1.10/$4.40          |

Plus local models via Ollama, LM Studio, and llama.cpp.

## Routing Strategies

| Strategy        | When To Use                                            |
| --------------- | ------------------------------------------------------ |
| `quality-first` | Default with API keys. Best model for the task.        |
| `cost-first`    | Budget-constrained. Cheapest viable model.             |
| `capability`    | Eval scores available. Routes by measured performance. |
| `combined`      | Balances quality (40%), cost (35%), speed (15%).       |
| `learned`       | Thompson sampling from session outcomes.               |
| `rule-based`    | Custom rules in config.toml.                           |

## Configuration

```toml
# ~/.brainstorm/config.toml
[general]
defaultStrategy = "quality-first"
maxSteps = 10
subagentIsolation = "none"  # none | git-stash | docker

[budget]
daily = 50.00
monthly = 500.00

[shell]
sandbox = "restricted"  # none | restricted | container

[providers.ollama]
enabled = true
```

Project-level context via `BRAINSTORM.md` (hierarchical: global → root → subdirectory):

```markdown
---
build_command: npx turbo run build
test_command: npx turbo run test
---

## Conventions

- TypeScript with ESM
- Use Zod for validation
- All packages use tsup bundling
```

## BrainstormRouter Integration

Native tools for querying [BrainstormRouter](https://brainstormrouter.com):

| Tool               | Endpoint                 | Purpose                                |
| ------------------ | ------------------------ | -------------------------------------- |
| `br_status`        | `/v1/self`               | System check: identity, budget, health |
| `br_budget`        | `/v1/budget/status`      | Spend forecast + remaining balance     |
| `br_leaderboard`   | `/v1/models/leaderboard` | Production performance rankings        |
| `br_insights`      | `/v1/insights/optimize`  | Cost optimization suggestions          |
| `br_models`        | `/v1/models`             | Available models with pricing          |
| `br_memory_search` | `/v1/memory/query`       | Search persistent memory               |
| `br_memory_store`  | `/v1/memory/entries`     | Save facts across sessions             |
| `br_health`        | `/v1/health`             | Connectivity test                      |

Dashboard mode [2] also pulls: waste detection, guardian audit trail, budget forecast, daily cost trends.

## Development

```bash
git clone https://github.com/justinjilg/brainstorm.git
cd brainstorm
npm install
npx turbo run build        # Build all 16 packages
npx turbo run test         # Run 90 tests
node packages/cli/dist/brainstorm.js chat  # Run locally
```

## Version History

| Version | Highlights                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| **v11** | Claude Code parity: SelectPrompt, autocomplete, /context, /undo, /insights, shortcut overlay, error categories |
| **v10** | DeerFlow gaps: artifact persistence, temporal context, prose style learning, test result parsing               |
| **v9**  | `/build` multi-model workflow wizard with per-step model assignment                                            |
| **v8**  | Tech debt + BR dashboard (leaderboard, waste, audit, forecast, trends)                                         |
| **v7**  | Multi-mode TUI: Chat/Dashboard/Models/Config with live data                                                    |
| **v6**  | Role-based workflows: /architect, /sr-developer, /jr-developer, /qa                                            |
| **v5**  | TUI overhaul: spinner, syntax highlighting, tool tracking, scrolling                                           |
| **v4**  | 25 features: semantic search, Docker sandbox, MCP OAuth, Thompson sampling                                     |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[Apache License 2.0](LICENSE)
