# @brainst0rm/tools

42 built-in tools with Zod input schemas, permission levels, and consistent `{ ok, data, error }` output.

## Key Exports

- `createDefaultToolRegistry()` — Register all 42 built-in tools
- `defineTool()` — Define a new tool with schema and execute function
- `ToolRegistry` — Tool registration and permission-wrapped AI SDK conversion
- `CheckpointManager` — File snapshots for undo support
- `SessionFileTracker` — Track file reads/writes per session
- `ToolHealthTracker` — Track tool success/failure rates

## Tool Categories

- Filesystem (8), Shell (3), Git (6), GitHub (2), Web (2), Tasks (3)
- Agent (6), Planning (1), Transactions (3), BrainstormRouter (8)

See [docs/tools.md](../../docs/tools.md) for full reference.

## Adding a Tool

```typescript
import { z } from "zod";
import { defineTool } from "../base.js";

export const myTool = defineTool({
  name: "my_tool",
  description: "What this tool does",
  permission: "confirm",
  inputSchema: z.object({ param: z.string() }),
  async execute({ param }) {
    return { ok: true, data: { result: "done" } };
  },
});
```
