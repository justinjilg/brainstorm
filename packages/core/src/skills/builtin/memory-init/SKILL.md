---
name: memory-init
description: Initialize memory from project files and optionally import from Claude Code session history. Use when starting a new project or running /init.
max_steps: 10
---

# Memory Initialization

Bootstrap the memory system for this project. Read project context files, extract key information, and create structured memory entries.

## Process

### Phase 1: Read Project Context (parallel)

Read these files if they exist (use file_read, don't fail if missing):

1. `CLAUDE.md` — project instructions and conventions
2. `README.md` — project description, setup, architecture
3. `package.json` — dependencies, scripts, project name
4. `BRAINSTORM.md` — brainstorm-specific project context
5. `.github/CODEOWNERS` — team ownership structure

### Phase 2: Extract and Create Memory Entries

From the files above, create memory entries using the `memory` tool:

**System tier (always in prompt):**

- `project-overview` (type: project, tier: system) — What this project is, its stack, and primary purpose. 3-5 sentences.
- `conventions` (type: feedback, tier: system) — Coding conventions, style rules, and patterns found in CLAUDE.md or README.
- `user-identity` (type: user, tier: system) — Git user name and email from `git config user.name` and `git config user.email`.

**Archive tier (searchable on demand):**

- `dependencies` (type: reference, tier: archive) — Key dependencies and their purposes.
- `build-commands` (type: reference, tier: archive) — How to build, test, and run the project.
- `architecture` (type: project, tier: archive) — High-level architecture notes if found.

### Phase 3: Import Claude Code History (optional)

If `~/.claude/projects/` exists, look for session history matching this project path. Extract:

- User preferences expressed across sessions
- Recurring patterns or corrections
- Hard rules the user enforced

Create memory entries for each finding (type: feedback, tier: system for strong preferences, archive for incidental notes).

## Rules

- Do NOT create empty or placeholder memories. Only write entries with real content.
- Keep each entry concise — under 500 characters for system tier, under 1000 for archive.
- Use the `memory` tool's write operation for all entries.
- Run git commands to get user identity — this is always useful context.
