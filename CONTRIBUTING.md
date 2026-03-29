# Contributing to Brainstorm

Thank you for your interest in contributing to Brainstorm!

## Development Setup

```bash
git clone https://github.com/justinjilg/brainstorm.git
cd brainstorm
npm install
npx turbo run build
```

**Requirements:** Node.js 20+, npm 10+

## Repository Structure

Brainstorm is a Turborepo monorepo with 20 TypeScript packages in `packages/`. The dependency graph flows upward:

```
cli → core → router → providers → config → shared
         ↘ tools                   ↗
          → agents → db ──────────╯
          → workflow
          → orchestrator
          → projects
          → scheduler
          → hooks
          → mcp
          → eval
          → gateway
          → vault
          → plugin-sdk
```

### Package Conventions

- ESM everywhere (`"type": "module"`)
- Bundled with tsup (outputs to `dist/`)
- Inter-package imports use `.js` extensions
- Zod for all runtime schemas
- pino for logging
- AI SDK v6 patterns (`streamText`, `tool()` with `inputSchema`)

### Key Directories

| Directory                            | Purpose                                 |
| ------------------------------------ | --------------------------------------- |
| `packages/cli/src/components/`       | Ink (React for terminal) TUI components |
| `packages/cli/src/commands/`         | Slash commands and role definitions     |
| `packages/cli/src/bin/brainstorm.ts` | Commander entry point                   |
| `packages/tools/src/builtin/`        | Built-in tool definitions               |
| `packages/core/src/middleware/`      | 10-stage middleware pipeline            |
| `packages/core/src/plan/`            | Plan executor and orchestration engine  |
| `.brainstorm/agents/`                | Built-in agent profiles (`.agent.md`)   |
| `docs/`                              | Project documentation                   |

## Building

```bash
npx turbo run build              # Build all packages (cached)
npx turbo run build --force      # Rebuild everything
npx turbo run build --filter=@brainstorm/cli  # Build one package + deps
npx turbo run typecheck          # Type check all packages
```

## Testing

```bash
npx turbo run test               # Run all tests
npx turbo run test --filter=@brainstorm/core   # Test one package

# Run the CLI locally
node packages/cli/dist/brainstorm.js chat
```

Tests use vitest. Current coverage:

- `packages/core/` — 67 tests (middleware, search, skills, loop detection, compaction)
- `packages/tools/` — 23 tests (sandbox, Docker, file operations)
- `packages/cli/` — 135 tests (TUI components, integration)

## Adding a Tool

Tools live in `packages/tools/src/builtin/`. To add one:

1. Create the tool:

```typescript
// packages/tools/src/builtin/my-tool.ts
import { z } from "zod";
import { defineTool } from "../base.js";

export const myTool = defineTool({
  name: "my_tool",
  description: "What it does, its limits, what failure looks like.",
  permission: "auto", // 'auto' | 'confirm' | 'deny'
  inputSchema: z.object({
    param: z.string().describe("What this param is for"),
  }),
  async execute({ param }) {
    return { result: "done" };
  },
});
```

2. Register in `packages/tools/src/index.ts`
3. Build and test: `npx turbo run build --filter=@brainstorm/tools`

## Adding an Agent

Agent profiles are declarative `.agent.md` files in `.brainstorm/agents/`:

```markdown
---
name: my-agent
description: One-line description
type: code
model_hint: sonnet
tools:
  - file_read
  - file_write
  - shell
max_steps: 10
---

You are a specialized agent that...
```

See existing agents in `.brainstorm/agents/` for examples.

## Adding a Slash Command

Slash commands are registered in `packages/cli/src/commands/slash.ts`. Each has:

```typescript
{
  name: "mycommand",
  aliases: ["mc"],
  description: "What it does",
  usage: "/mycommand [args]",
  execute: async (args, ctx, invokedAs) => {
    return "Result string";
  },
}
```

## Pull Request Guidelines

- **One feature per PR** — keep changes focused
- **Build must pass:** `npx turbo run build && npx turbo run test`
- **Include tests** for new functionality
- **Update docs** in `docs/` if adding user-facing features
- **Conventional commits:** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`

### Commit Message Format

```
feat: add multi-file editing support

- Implements batch file operations in tools package
- Adds checkpoint before multi-file writes
- Updates tool registry with new permission level
```

## Code Style

- TypeScript strict mode — no `any` without justification
- Zod for all runtime validation
- pino for structured logging
- Prefer `async/await` over raw promises
- Error handling: return `{ error: string }` from tools, throw from middleware
- No default exports (named exports only)

## Architecture Decisions

- **No Python on the hot path** — ML models export to ONNX for onnxruntime-node
- **TOML for config** — not YAML, not JSON. Layered: defaults → global → project → env
- **SQLite for persistence** — WAL mode, auto-migrations, single file at `~/.brainstorm/brainstorm.db`
- **BrainstormRouter for cloud routing** — never call provider APIs directly
- **AI SDK v6** — `streamText`, `tool()` with `inputSchema`/`outputSchema`, `stopWhen: stepCountIs(N)`

## Questions?

Open an [issue](https://github.com/justinjilg/brainstorm/issues) or start a [discussion](https://github.com/justinjilg/brainstorm/discussions).
