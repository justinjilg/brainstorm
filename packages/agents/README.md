# @brainst0rm/agents

Agent profiles, natural language parser, and the subagent system.

## Key Exports

- `AgentProfileManager` — Load, create, and manage agent profiles
- `parseAgentRequest()` — NL parser for agent-related commands
- `spawnSubagent()` / `spawnParallel()` — Spawn specialized subagents

## Subagent Types

| Type     | Tools                                   | Purpose               |
| -------- | --------------------------------------- | --------------------- |
| research | file_read, glob, grep, web_fetch        | Read-only exploration |
| code     | file_read, file_write, file_edit, shell | Implementation        |
| review   | file_read, grep, git_diff               | Code review           |
| refactor | file_read, file_write, file_edit, glob  | Refactoring           |
| test     | file_read, file_write, shell            | Test writing          |

Subagents run with budget isolation and can execute in parallel.
