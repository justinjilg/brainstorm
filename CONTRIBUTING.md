# Contributing to Brainstorm

Thank you for your interest in contributing to Brainstorm! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/justinjilg/brainstorm.git
cd brainstorm
npm install
npx turbo run build
```

## Project Structure

Brainstorm is a Turborepo monorepo with 15 TypeScript packages in `packages/`. Each package:
- Uses ESM (`"type": "module"`)
- Bundles with tsup
- Uses Zod for schemas
- Uses `.js` extensions for inter-package imports

## Adding a Tool

Tools live in `packages/tools/src/builtin/`. To add one:

1. Create `packages/tools/src/builtin/my-tool.ts`:

```typescript
import { z } from 'zod';
import { defineTool } from '../base.js';

export const myTool = defineTool({
  name: 'my_tool',
  description: 'What it does, its limits, what failure looks like.',
  permission: 'auto',  // 'auto' | 'confirm' | 'deny'
  inputSchema: z.object({
    param: z.string().describe('What this param is for'),
  }),
  async execute({ param }) {
    // Return { ok: true, ...data } on success
    // Return { error: '...' } on failure (normalizeResult wraps it)
    return { result: 'done' };
  },
});
```

2. Register in `packages/tools/src/index.ts`:
```typescript
import { myTool } from './builtin/my-tool.js';
// ... in createDefaultToolRegistry():
registry.register(myTool);
```

3. Build and test:
```bash
npx turbo run build --filter=@brainstorm/tools
storm run --tools "Use my_tool to do something"
```

## Pull Request Guidelines

- One feature per PR
- Run `npx turbo run build` before submitting
- Include tests for new functionality
- Update relevant documentation
- Commit messages: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`

## Code Style

- TypeScript strict mode
- Zod for all schemas
- pino for logging
- AI SDK v6 patterns (`streamText`, `tool()`, `inputSchema`)

## Questions?

Open an issue or start a discussion on GitHub.
