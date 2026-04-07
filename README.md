<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg" />
    <img src="assets/logo-dark.svg" alt="Brainstorm" width="380" />
  </picture>
</p>

<p align="center">
  <strong>Governed control plane for AI-managed infrastructure</strong><br/>
  <sub>Connect AI operators to your entire product ecosystem through a standardized protocol. 117 tools. 5 products. One command.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@brainst0rm/cli"><img src="https://img.shields.io/npm/v/@brainst0rm/cli.svg?color=d97706" alt="npm version" /></a>&nbsp;
  <a href="https://www.npmjs.com/package/@brainst0rm/cli"><img src="https://img.shields.io/npm/dm/@brainst0rm/cli.svg?color=d97706" alt="npm downloads" /></a>&nbsp;
  <a href="https://github.com/justinjilg/brainstorm/actions/workflows/ci.yml"><img src="https://github.com/justinjilg/brainstorm/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>&nbsp;
  <img src="https://img.shields.io/badge/products-5-d97706.svg" alt="Products" />&nbsp;
  <img src="https://img.shields.io/badge/tools-117-d97706.svg" alt="Tools" />&nbsp;
  <img src="https://img.shields.io/badge/packages-25-d97706.svg" alt="Packages" />
</p>

<p align="center">
  <a href="https://brainstorm.co">Website</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="docs/getting-started.md">Getting Started</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="docs/platform-contract-v1.md">Platform Contract</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="CHANGELOG.md">Changelog</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## What is Brainstorm?

Brainstorm connects AI operators (Claude Code, Claude Desktop, or any MCP-compatible agent) to your infrastructure through a governed channel. Every action flows through safety controls, cost management, and tamper-evident audit trails.

```bash
npm install -g @brainst0rm/cli
brainstorm setup
brainstorm status
```

```
Products:
  ● BrainstormMSP        79 tools  brainstormmsp.ai        78ms  healthy
  ● BrainstormRouter      10 tools  api.brainstormrouter.com 12ms  healthy
  ○ BrainstormGTM          9 tools  catsfeet.com             —    offline
  ○ BrainstormVM           9 tools  vm.brainstorm.co         —    offline
  ○ BrainstormShield      10 tools  shield.brainstorm.co     —    offline

117 tools available across ecosystem.
```

## For AI Operators

If you're an LLM operating this codebase or using brainstorm as a tool:

| Resource                                                   | What it provides                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`docs/llm-operator-guide.md`](docs/llm-operator-guide.md) | Full CLI contract, tool reference, error shapes, auth, headless safety |
| [`docs/tool-catalog.json`](docs/tool-catalog.json)         | Machine-readable JSON Schema for all 45 built-in tools                 |
| `brainstorm introspect`                                    | Runtime capabilities dump (JSON): tools, models, auth state, config    |

**Non-interactive usage:**

```bash
brainstorm run --json --tools "your prompt"                    # Single prompt, JSON output
brainstorm run --json --tools --lfg --max-steps 15 "prompt"    # Full automation, no approval prompts
brainstorm introspect                                          # Discover capabilities (always JSON)
```

## How it works

Every product implements the same contract — 3 endpoints:

```
GET  /health                    → Is it alive?
GET  /api/v1/god-mode/tools     → What can it do?
POST /api/v1/god-mode/execute   → Do it.
```

The CLI discovers products at runtime. Adding a new product = 5 lines of config. Zero code changes.

## For AI operators

Brainstorm exposes all God Mode tools via **MCP** (Model Context Protocol). Claude Code spawns `brainstorm mcp` as a subprocess and gets direct access to every connected product.

```
"list all managed devices"
  → Claude calls msp_list_devices tool
  → Brainstorm routes to MSP server
  → Real data: Justin's MacBook Pro, macOS 26.2, serial LG4V52HNH9

"isolate that laptop"
  → ChangeSet created (Risk: 65/100)
  → Simulation: drops all connections except management
  → Cascades: VPN disconnected, Time Machine paused
  → Awaiting approval...
```

Destructive actions **always** go through ChangeSets: simulation → approval → execution. No AI can destroy a VM or isolate a device without showing you what will happen first.

## Safety

| Layer                  | What it does                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **ChangeSets**         | Every mutation simulated before execution. Risk scored 0-100. User approves.                                               |
| **HMAC event signing** | Cross-product events signed with per-tenant HKDF-derived keys. Tamper-evident.                                             |
| **Tenant isolation**   | Every query scoped to `platform_tenant_id`. Verified by RLS policies and dedicated test suites.                            |
| **Rate limiting**      | 60 req/min per tenant per product.                                                                                         |
| **PQC signing**        | Evidence chains signed with hybrid Ed25519 + ML-DSA-65 when `pqcrypto` is installed. Falls back to Ed25519-only otherwise. |
| **BrainstormRouter**   | Cost tracking, budget enforcement, model selection via Thompson sampling.                                                  |

## Products

| Product              | Tools | What it manages                                                                    |
| -------------------- | ----- | ---------------------------------------------------------------------------------- |
| **BrainstormMSP**    | 79    | Devices, backups, compliance, security, edge agents, AD, scripts, patches, osquery |
| **BrainstormRouter** | 10    | LLM models, cost, budgets, API keys, memory                                        |
| **BrainstormGTM**    | 9     | AI agents, campaigns, leads, analytics                                             |
| **BrainstormVM**     | 9     | VMs, storage, network, live migration                                              |
| **BrainstormShield** | 10    | Email security, quarantine, trust graphs, threat intel                             |

## Commands

```bash
brainstorm setup              # Bootstrap: auth, config, MCP, connectivity
brainstorm status             # Full ecosystem diagnostic
brainstorm mcp                # MCP server for Claude Code/Desktop
brainstorm serve              # HTTP API for dashboards
brainstorm run --tools "..."  # Single-shot with God Mode tools
brainstorm platform verify    # Test product contract compliance
brainstorm platform init      # Generate product manifest template
```

## Adding a product

Any HTTP server that implements the [platform contract](docs/platform-contract-v1.md) becomes part of the ecosystem:

```toml
# brainstorm.toml
[godmode.connectors.myproduct]
enabled = true
displayName = "My Product"
baseUrl = "https://myproduct.example.com"
apiKeyName = "MYPRODUCT_API_KEY"
```

```bash
brainstorm platform verify https://myproduct.example.com
# ✓ GET /health — 200 OK
# ✓ GET /api/v1/god-mode/tools — 8 tools
# ✓ POST /api/v1/god-mode/execute — working
# Product implements the platform contract.
```

Restart Claude Code. The new product's tools appear automatically.

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
npx turbo run test           # Run tests (171 tests across 4 packages)
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
