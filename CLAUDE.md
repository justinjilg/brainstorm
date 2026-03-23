# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Brainstorm — an open-source, CLI-first AI coding assistant with intelligent model routing (BrainstormRouter). Routes tasks to the optimal model (cloud or local) based on task complexity, cost, and user-defined rules.

## Architecture

Turborepo monorepo with 8 TypeScript packages:

- `packages/shared` — Types (TaskProfile, ModelEntry, RoutingDecision, etc.), errors, pino logger
- `packages/config` — Zod schemas, TOML config loader, layered config (defaults → global → project → env), BRAINSTORM.md parser
- `packages/db` — better-sqlite3 persistence (sessions, messages, cost_records, model_performance), auto-migrations
- `packages/providers` — AI Gateway (cloud) + Ollama/LM Studio/llama.cpp (local) via @ai-sdk/openai-compatible, auto-discovery
- `packages/router` — BrainstormRouter: heuristic task classifier, 4 routing strategies (cost-first, quality-first, rule-based, combined), CostTracker, fallback chain
- `packages/tools` — Built-in tools (file_read, file_write, file_edit, shell, glob, grep) with AI SDK v6 tool() + permission levels
- `packages/core` — Agentic loop using AI SDK v6 streamText + stepCountIs, SessionManager, context builder
- `packages/cli` — Commander subcommands (chat, run, models, config, budget), readline-based interactive chat

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
