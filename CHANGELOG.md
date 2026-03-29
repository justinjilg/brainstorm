# Changelog

## [v12] — 2026-03-28 — Orchestration Engine

- 9-phase orchestration pipeline: `storm orchestrate pipeline`
- 11 built-in role agents (`.agent.md` format)
- Trajectory capture for BrainstormLLM v2 training
- Smart phase selection (33-78% cost savings)
- TUI Mode 5: Planning with collapsible tree visualization
- `storm intelligence` — BR intelligence report
- `storm projects` / `storm schedule` / `storm plan execute`
- Expert Persona Engine with model-specific tuning
- Agent memory tools (save, search, list, forget)
- Security scan middleware (19 credential detection patterns)
- 3 new packages: `@brainstorm/projects`, `@brainstorm/scheduler`, `@brainstorm/orchestrator`
- Fix: TUI stability (abort timeout race, tool ID collisions, streaming re-renders)

## [v11] — 2026-02-15 — Claude Code Parity

- SelectPrompt (interactive arrow-key selection)
- Autocomplete (filtered slash command dropdown)
- `/context` (token breakdown with gauge), `/undo`, `/insights`
- Shortcut overlay (`?` in non-chat modes)
- Error categories with recovery suggestions

## [v10] — 2026-01-20 — DeerFlow Gaps

- Artifact persistence with manifests
- Temporal context injection
- Prose style learning from user patterns
- Test result parsing and display

## [v9] — 2026-01-08 — Build Wizard

- `/build` multi-model workflow wizard
- Per-step model assignment
- Cost estimation before execution
- 4 preset workflows

## [v8] — 2025-12-18 — BR Dashboard

- Dashboard mode with live BrainstormRouter data
- Model leaderboard, waste detection, guardian audit
- Budget forecast, 7-day cost trends

## [v7] — 2025-12-05 — Multi-Mode TUI

- 4-mode TUI: Chat / Dashboard / Models / Config
- Mode switching with Esc + number keys
- Provider-colored model names

## [v6] — 2025-11-20 — Role Workflows

- 5 roles: `/architect`, `/sr-developer`, `/jr-developer`, `/qa`, `/product-manager`
- One-command model + prompt + tools + output style configuration

## [v5] — 2025-11-10 — TUI Overhaul

- Streaming with spinners, syntax highlighting
- Tool tracking (status, duration), scrollable messages
- Catppuccin theme

## [v4] — 2025-10-25 — Foundation

- Semantic code search (TF-IDF), Docker sandbox
- MCP client with OAuth, Thompson sampling routing
- Cross-session learning, encrypted vault (AES-256-GCM + Argon2id)
- 1Password integration
