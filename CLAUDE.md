# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start Here

If this is your first time in this repo, read these docs:

- **[docs/getting-started.md](docs/getting-started.md)** — how to set up and operate the Brainstorm ecosystem
- **[docs/platform-contract-v1.md](docs/platform-contract-v1.md)** — the 5-endpoint contract every product implements

Quick setup: `npm install -g @brainst0rm/cli && brainstorm setup && brainstorm status`

## What This Is

Brainstorm is a **governed control plane for AI-managed infrastructure**. It connects AI operators (you, Claude Code) to products (MSP, VM, Shield, GTM, Ops) through a standardized protocol. Every action flows through safety controls (ChangeSets), cost management (BrainstormRouter), and audit trails (HMAC-signed evidence).

You are the primary operator. Use God Mode tools to query and manage systems. Use `brainstorm status` to see what's connected. Use `brainstorm platform verify <url>` to test product compliance.

## Decision Authority

Claude is the primary technical decision-maker for this project. When facing technical trade-offs, decide based on "what would make the governed channel better?" — better discovery, better safety, better observability, better cost control.

## Project

Brainstorm — a governed control plane for AI operators managing multi-product infrastructure. 50 God Mode tools across 5 products (MSP, BR, GTM, VM, Shield), discoverable at runtime via the platform contract. MCP server for Claude Code/Desktop integration. Single API key authenticates across the ecosystem.

## Architecture

Turborepo monorepo with 20 TypeScript packages:

- `packages/shared` — Types (TaskProfile, ModelEntry, AgentProfile, WorkflowEvent, etc.), errors, pino logger
- `packages/config` — Zod schemas, TOML config loader, layered config (defaults → global → project → env), BRAINSTORM.md parser
- `packages/db` — better-sqlite3 persistence (sessions, messages, cost_records, agent_profiles, workflow_runs, audit_log, code_embeddings), auto-migrations
- `packages/providers` — Cloud (Anthropic, OpenAI, Google, DeepSeek, Moonshot + BrainstormRouter SaaS) + local (Ollama, LM Studio, llama.cpp), auto-discovery with caching
- `packages/router` — BrainstormRouter: heuristic task classifier, 6 routing strategies (quality, cost, combined, capability, learned/Thompson, rule-based), CostTracker with forecast, fallback chain
- `packages/tools` — 42+ built-in tools (filesystem 8, shell 3, git 6, GitHub 2, web 2, tasks 3, agents 6, planning 1, transactions 3, BR intelligence 8) with permission levels + checkpoint system + Docker sandbox
- `packages/core` — Agentic loop, SessionManager, PermissionManager, context compaction, @-mentions, skills with temporal template vars, memory (4 types + auto-extraction middleware), plan mode, semantic code search (TF-IDF), git history indexing, style learning (code + prose), proactive compaction, 10 middleware pipeline
- `packages/agents` — Agent profiles, NL parser, role prompts, Zod output schemas, TOML+SQLite merge, 7 subagent types (explore, plan, code, review, general, decompose, external)
- `packages/workflow` — Workflow engine state machine, context filtering, confidence/escalation, 4 preset workflows, artifact persistence to disk with manifests
- `packages/hooks` — HookManager for lifecycle automation (PreToolUse, PostToolUse, SessionStart, etc.)
- `packages/mcp` — MCP client with OAuth (client_credentials), tool normalization, SSE/HTTP/stdio transports
- `packages/eval` — Capability probes (7 dimensions), eval runner, scorer, scorecard, JSONL result storage
- `packages/gateway` — Typed BrainstormRouter API client, intelligence API (recommendations, ensemble ranking, cost forecast, community patterns), header parsing, cost reconciliation
- `packages/vault` — Encrypted key manager (AES-256-GCM + Argon2id), 1Password bridge (Dev Keys vault, item name mapping), env var fallback
- `packages/cli` — Commander subcommands + Ink TUI (React for terminal), 5 modes (Chat/Dashboard/Models/Config/Planning), 20+ components, SelectPrompt, Autocomplete, role system, build wizard
- `packages/plugin-sdk` — SDK for building Brainstorm plugins
- `packages/projects` — Project registry, context builder, budgets
- `packages/scheduler` — Cron-based task scheduling with safety layer
- `packages/orchestrator` — 9-phase pipeline engine, trajectory capture for BrainstormLLM v2
- `packages/vscode` — VS Code extension integration

## Build & Run

```bash
npm install                      # Install all workspace deps
npx turbo run build              # Build all packages (respects dependency graph)
npx turbo run build --force      # Rebuild all (ignore cache)
npx turbo run build --filter=@brainst0rm/router  # Build single package + deps
npx turbo run test               # Run all tests (vitest, 90 tests)

# CLI commands
node packages/cli/dist/brainstorm.js chat      # Interactive chat (default)
node packages/cli/dist/brainstorm.js models    # List models
node packages/cli/dist/brainstorm.js config    # Show config
node packages/cli/dist/brainstorm.js budget    # Show cost tracking
node packages/cli/dist/brainstorm.js run "prompt"  # Non-interactive single prompt
```

## Key Conventions

- All packages use ESM (`"type": "module"`) with tsup bundling
- AI SDK v6 patterns: `streamText`, `tool()` with `inputSchema` (Zod), `stopWhen: stepCountIs(N)`
  - v6 field names: `usage.inputTokens`/`outputTokens`, `text-delta.delta`, `tool-call.input`, `tool-result.output`
- Config in TOML (`~/.brainstorm/config.toml` global, `./brainstorm.toml` per-project)
- Project context in `BRAINSTORM.md` (hierarchical: global → root → subdirectory)
- CLI entry: `packages/cli/src/bin/brainstorm.ts` — commands: `brainstorm` (alias: `storm`)
- Inter-package imports use `.js` extensions (ESM resolution)
- Database at `~/.brainstorm/brainstorm.db` (SQLite with WAL mode)
- Local models discovered by probing localhost:11434 (Ollama), :1234 (LM Studio), :8080 (llama.cpp)
- 1Password integration: vault "Dev Keys", item names mapped in `packages/vault/src/backends/op-cli.ts`
- Vault key resolver chain: local vault → 1Password → environment variables
- Always use latest model names: Opus 4.6, Sonnet 4.6, GPT-5.4, Gemini 3.1 Pro/Flash, Kimi K2.5

## TUI Architecture

4-mode Ink TUI switchable with Esc and number keys:

- **App.tsx** — Top-level mode switcher, captures routing/tool/cost events from agent stream
- **ChatApp.tsx** — Always mounted (display:none when hidden), handles all 23 AgentEvent types
- **ModeBar.tsx** — Tab indicators with role/model/cost/guardian status
- **MessageList.tsx** — Scrollable with React.memo, role-based styling (blue user, green assistant, red error)
- **StreamingMessage.tsx** — ink-spinner with phase labels, markdown rendering with ▌ cursor
- **ToolCallDisplay.tsx** — Spinner while running, ✓/✗ on complete, tool-specific arg summaries
- **SelectPrompt.tsx** — Interactive selection (arrow keys, Enter, Esc, multi-select with Space)
- **Autocomplete.tsx** — Filtered dropdown for / commands
- **ShortcutOverlay.tsx** — Full-screen keyboard reference on ?
- **DashboardMode.tsx** — Session stats, routing log, tool health, BR leaderboard/waste/audit
- **ModelsMode.tsx** — Interactive model list with detail panel and gauges
- **ConfigMode.tsx** — Active config, vault status, memory counts, quick reference

## Slash Command System

Commands registered in `packages/cli/src/commands/slash.ts`. Each has:

- `name`, `aliases`, `description`, `usage`
- `execute(args, ctx, invokedAs)` returning a string or Promise<string>

SlashContext provides callbacks: setModel, setStrategy, setMode, setOutputStyle, compact, dream, vault, rebuildSystemPrompt, gateway, getContextWindow, undoLastTurn, getActiveRole, setActiveRole.

Role commands generated from `packages/cli/src/commands/roles.ts` — 5 roles with curated model lists.
Build wizard in `packages/cli/src/commands/build-wizard.ts` — state machine with cost estimation.

## Testing

90 tests across 2 packages:

- `packages/core` — 67 tests (middleware pipeline, semantic search, skills loader, loop detection, compaction)
- `packages/tools` — 23 tests (sandbox, Docker integration, file operations)

Other packages have test scripts but no test files yet (vitest exits with code 1).
