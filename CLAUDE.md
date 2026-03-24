# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Decision Authority

Claude is the primary technical decision-maker for this project. As the AI being orchestrated by BrainstormRouter, Claude has unique insight into what an LLM needs from a routing/orchestration layer — context management, latency sensitivity, cost awareness, quality thresholds, and tool calling patterns. When facing technical trade-offs, decide based on "what would make me most effective as the orchestrated AI?" and explain the reasoning.

## Project

Brainstorm — an open-source, CLI-first AI coding assistant with intelligent model routing (BrainstormRouter). Routes tasks to the optimal model (cloud or local) based on task complexity, cost, and user-defined rules. Open-core model: free CLI + BrainstormRouter SaaS for intelligent cloud routing.

## Architecture

Turborepo monorepo with 15 TypeScript packages:

- `packages/shared` — Types (TaskProfile, ModelEntry, AgentProfile, WorkflowEvent, etc.), errors, pino logger
- `packages/config` — Zod schemas, TOML config loader, layered config (defaults → global → project → env), BRAINSTORM.md parser
- `packages/db` — better-sqlite3 persistence (sessions, messages, cost_records, agent_profiles, workflow_runs), auto-migrations
- `packages/providers` — AI Gateway + BrainstormRouter SaaS (cloud) + Ollama/LM Studio/llama.cpp (local), auto-discovery with caching
- `packages/router` — BrainstormRouter: heuristic task classifier, 4 routing strategies, CostTracker, fallback chain
- `packages/tools` — 20 built-in tools (filesystem 8, shell 3, git 4, web 2, tasks 3) with permission levels + checkpoint system
- `packages/core` — Agentic loop, SessionManager, PermissionManager, context compaction, @-mentions, skills, memory, plan mode, multimodal, security (path guard, credential scanner, .brainstormignore)
- `packages/agents` — Agent profiles, NL parser, role prompts, Zod output schemas, TOML+SQLite merge
- `packages/workflow` — Workflow engine state machine, context filtering, confidence/escalation, 4 preset workflows
- `packages/hooks` — HookManager for lifecycle automation (PreToolUse, PostToolUse, SessionStart, etc.)
- `packages/mcp` — MCP client for external tool integration (SSE/HTTP transports)
- `packages/eval` — Capability probes, eval runner, scorer, scorecard, JSONL result storage
- `packages/gateway` — Typed BrainstormRouter API client, header parsing, cost reconciliation
- `packages/vault` — Encrypted key manager (AES-256-GCM + Argon2id), 1Password bridge, env var fallback
- `packages/cli` — Commander subcommands (chat, run, models, config, budget, agent, workflow, sessions), Ink TUI

## Build & Run

```bash
npm install                      # Install all workspace deps
npx turbo run build              # Build all packages (respects dependency graph)
npx turbo run build --force      # Rebuild all (ignore cache)
npx turbo run build --filter=@brainstorm/router  # Build single package + deps
npx turbo run test               # Run all tests (vitest)

# CLI commands
node packages/cli/dist/brainstorm.js models    # List models (auto-discovers local)
node packages/cli/dist/brainstorm.js config    # Show config
node packages/cli/dist/brainstorm.js budget    # Show cost tracking
node packages/cli/dist/brainstorm.js run "prompt"  # Non-interactive single prompt
node packages/cli/dist/brainstorm.js chat      # Interactive chat (default)
```

## Key Conventions

- All packages use ESM (`"type": "module"`) with tsup bundling
- AI SDK v6 patterns: `streamText`, `tool()` with `inputSchema` (Zod), `stopWhen: stepCountIs(N)`
  - v6 field names: `usage.inputTokens`/`outputTokens` (not promptTokens), `text-delta.delta` (not textDelta), `tool-call.input` (not args), `tool-result.output` (not result)
- Config in TOML (`~/.brainstorm/config.toml` global, `./brainstorm.toml` per-project)
- Project context in `BRAINSTORM.md` (like CLAUDE.md but for the end user's projects)
- CLI entry: `packages/cli/src/bin/brainstorm.ts` — commands: `brainstorm` (alias: `storm`)
- Inter-package imports use `.js` extensions (ESM resolution)
- Database at `~/.brainstorm/brainstorm.db` (SQLite with WAL mode)
- Local models discovered by probing localhost:11434 (Ollama), :1234 (LM Studio), :8080 (llama.cpp)
