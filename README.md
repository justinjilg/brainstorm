<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg" />
    <img src="assets/logo-dark.svg" alt="Brainstorm" width="380" />
  </picture>
</p>

<p align="center">
  <strong>Open-source AI coding assistant with intelligent multi-model routing</strong><br/>
  <sub>Routes every task to the optimal model — architecture to Opus, coding to Sonnet, quick edits to Haiku — automatically.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@brainst0rm/cli"><img src="https://img.shields.io/npm/v/@brainst0rm/cli.svg?color=d97706" alt="npm version" /></a>&nbsp;
  <a href="https://www.npmjs.com/package/@brainst0rm/cli"><img src="https://img.shields.io/npm/dm/@brainst0rm/cli.svg?color=d97706" alt="npm downloads" /></a>&nbsp;
  <a href="https://github.com/justinjilg/brainstorm/actions/workflows/ci.yml"><img src="https://github.com/justinjilg/brainstorm/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>&nbsp;
  <img src="https://img.shields.io/badge/models-10+-d97706.svg" alt="Models" />&nbsp;
  <img src="https://img.shields.io/badge/tools-42+-d97706.svg" alt="Tools" />&nbsp;
  <img src="https://img.shields.io/badge/packages-23-d97706.svg" alt="Packages" />
</p>

<p align="center">
  <a href="https://brainstorm.co">Website</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="docs/getting-started.md">Docs</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="docs/feature-reference.md">Feature Reference</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="CHANGELOG.md">Changelog</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## Quickstart

```bash
npm install -g @brainst0rm/cli
storm chat
```

That's it. Brainstorm auto-discovers your API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) and local models (Ollama, LM Studio, llama.cpp). No configuration required.

## Why Brainstorm?

Every AI coding tool locks you into one model. Brainstorm routes each task to the best model for the job:

- **Architecture review?** Routed to Opus 4.6 — highest reasoning quality.
- **Implement a function?** Routed to Sonnet 4.6 — fast, capable, 5x cheaper.
- **Fix a typo?** Routed to Haiku 4.5 — instant, 19x cheaper.
- **Hit your budget?** Falls back to DeepSeek V3 or your local Ollama models — $0.

The router learns from outcomes via Thompson sampling. After a few sessions, it knows which models perform best for _your_ codebase and _your_ task types. The result: better code at lower cost, automatically.

### How it compares

|                         | Brainstorm | Claude Code | Cursor | Aider | Codex CLI |
| ----------------------- | :--------: | :---------: | :----: | :---: | :-------: |
| Multi-model routing     |     ✓      |             |        |   ~   |           |
| Thompson sampling       |     ✓      |             |        |       |           |
| Local model support     |     ✓      |             |        |   ✓   |           |
| Cost tracking + budgets |     ✓      |             |        |       |           |
| Encrypted vault         |     ✓      |             |        |       |           |
| 9-phase orchestration   |     ✓      |             |        |       |           |
| Plugin SDK              |     ✓      |      ✓      |   ~    |       |           |
| Terminal dashboard      |     ✓      |             |        |       |           |
| Open source             |     ✓      |             |        |   ✓   |     ✓     |
| IDE integration         |     ✓      |      ✓      |   ✓    |   ~   |           |

<sub>~ = partial support. Comparison as of March 2026. We use these tools daily and respect them all.</sub>

## What It Does

|                           |                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-model routing**   | 10+ models across 8 providers. 6 routing strategies including Thompson sampling from real outcomes. The system learns which models work best for which tasks.                          |
| **Terminal dashboard**    | 5-mode TUI — Chat, Dashboard, Models, Config, Planning. Live cost tracking, routing decisions, tool health, model performance. Switch with `Esc` + number keys.                        |
| **42 built-in tools**     | Filesystem, shell, git, GitHub, web search, planning, agents, transactions. Checkpoint/undo on every write. Docker sandbox option.                                                     |
| **Role workflows**        | `/architect` `/sr-developer` `/qa` — each sets the model, system prompt, tools, output style, and routing strategy in one command.                                                     |
| **9-phase orchestration** | `storm orchestrate pipeline "add OAuth"` runs: spec → architecture → implementation → review → verify → refactor → deploy → document → report. Each phase routed to the optimal model. |
| **Build wizard**          | `/build add login page` auto-detects workflow type, assigns models per step, shows cost estimate before execution.                                                                     |
| **Encrypted vault**       | AES-256-GCM + Argon2id. 1Password bridge. Three-backend key resolver chain.                                                                                                            |
| **Plugin SDK**            | Extend with custom tools, hooks, and skills. MCP client with OAuth.                                                                                                                    |
| **Intelligence**          | Semantic code search, git history indexing, style learning, cross-session memory, proactive context compaction.                                                                        |

## Architecture

23 TypeScript packages in a Turborepo monorepo:

```
cli ─────── core ─── router ─── providers ─── config ─── shared
              │        │
              ├── tools (42+)        ├── agents (11 roles, 8 subagent types)
              ├── workflow (4 presets)├── orchestrator (9-phase pipeline)
              ├── hooks (10 events)  ├── projects + scheduler
              ├── mcp (OAuth, SSE)   ├── eval (7 capability dimensions)
              ├── gateway (BR API)   ├── vault (AES-256-GCM)
              └── db (SQLite/WAL)    └── plugin-sdk + sdk + docgen + ingest
```

## Models

| Model             | Provider  | Tier      | Speed  | Cost/1M       |
| ----------------- | --------- | --------- | ------ | ------------- |
| Claude Opus 4.6   | Anthropic | Frontier  | ⚡     | $15 / $75     |
| Claude Sonnet 4.6 | Anthropic | Frontier  | ⚡⚡   | $3 / $15      |
| Claude Haiku 4.5  | Anthropic | Fast      | ⚡⚡⚡ | $0.80 / $4    |
| GPT-5.4           | OpenAI    | Frontier  | ⚡⚡   | $2.50 / $10   |
| Gemini 3.1 Pro    | Google    | Frontier  | ⚡⚡   | $1.25 / $5    |
| Gemini 3.1 Flash  | Google    | Fast      | ⚡⚡⚡ | $0.15 / $0.60 |
| Kimi K2.5         | Moonshot  | Frontier  | ⚡⚡   | $0.60 / $2.40 |
| DeepSeek V3       | DeepSeek  | Value     | ⚡⚡   | $0.27 / $1.10 |
| o3-mini           | OpenAI    | Reasoning | ⚡⚡   | $1.10 / $4.40 |

Plus local models via Ollama, LM Studio, and llama.cpp — auto-discovered on startup.

## Routing

| Strategy        | How It Works                                                |
| --------------- | ----------------------------------------------------------- |
| `quality-first` | Best model for the task type. Default.                      |
| `cost-first`    | Cheapest model that meets capability threshold.             |
| `combined`      | Weighted: quality 40%, cost 35%, speed 15%, capability 10%. |
| `capability`    | Routes by measured eval probe scores (7 dimensions).        |
| `learned`       | Thompson sampling — learns from session outcomes over time. |
| `rule-based`    | Custom rules in `config.toml`.                              |

## Commands

```bash
storm chat                       # Interactive session
storm run "prompt"               # Single-shot execution
storm models                     # List available models
storm config                     # Show configuration
storm budget                     # Cost tracking
storm intelligence               # BR intelligence report
storm orchestrate pipeline "..." # 9-phase pipeline
storm plan execute plan.md       # Autonomous plan execution
storm projects list              # Project management
storm schedule list              # Scheduled tasks
storm eval probe                 # Run capability probes
```

**In-session slash commands:** `/model` `/architect` `/sr-developer` `/qa` `/build` `/intelligence` `/context` `/insights` `/compact` `/undo` `/project` `/schedule` `/orchestrate` — see [full reference](docs/feature-reference.md#2-slash-commands).

## Configuration

```toml
# ~/.brainstorm/config.toml
[general]
defaultStrategy = "quality-first"
maxSteps = 10

[budget]
daily = 50.00

[shell]
sandbox = "restricted"   # none | restricted | container

[providers.ollama]
enabled = true
```

Project context via `BRAINSTORM.md` (hierarchical: global → root → subdirectory). See the [Configuration Guide](docs/config-guide.md).

## BrainstormRouter

[BrainstormRouter](https://brainstormrouter.com) is the multi-tenant AI gateway that powers intelligent routing. Brainstorm includes 8 native tools for querying it, plus `storm intelligence` for a human-readable report of what the system has learned.

```
storm intelligence

  BrainstormRouter Intelligence Report
  ══════════════════════════════════════

  Learning Status: 4,095 requests analyzed
  Routing Confidence: HIGH

  Model Performance:
    claude-3-haiku    reward:89%  value:1154  1.8s  (247 samples)
    gpt-4o            reward:52%  value:42    640ms (31 samples)
    ...
```

## Development

```bash
git clone https://github.com/justinjilg/brainstorm.git
cd brainstorm && npm install
npx turbo run build          # Build all 23 packages
npx turbo run test           # Run tests (90 tests)
node packages/cli/dist/brainstorm.js chat
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

## Documentation

| Doc                                              | What                                  |
| ------------------------------------------------ | ------------------------------------- |
| [Getting Started](docs/getting-started.md)       | Install, configure, first session     |
| [Feature Reference](docs/feature-reference.md)   | Complete reference for every feature  |
| [Architecture](docs/architecture.md)             | Package graph, data flow              |
| [Configuration](docs/config-guide.md)            | TOML schema, env vars, BRAINSTORM.md  |
| [Plugin Development](docs/plugin-development.md) | Custom tools, hooks, skills           |
| [Security](SECURITY.md)                          | Vulnerability reporting, architecture |
| [Changelog](CHANGELOG.md)                        | Version history                       |

## License

[Apache 2.0](LICENSE)

<p align="center"><sub>Built by <a href="https://brainstorm.co">Brainstorm</a> · Powered by <a href="https://brainstormrouter.com">BrainstormRouter</a></sub></p>
