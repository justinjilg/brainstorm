# @brainst0rm/shared

Foundation types, errors, and logging shared across all Brainstorm packages.

## Key Exports

- `TaskProfile` — Classified task descriptor (complexity, category, tokens)
- `ModelEntry` — Model with pricing, capabilities, provider
- `AgentProfile` — Agent configuration (role, tools, prompt)
- `TurnContext` — Per-turn state for agent self-awareness
- `AgentEvent` — Union type for all agent loop events
- `formatTurnContext()` — Compact one-liner for context injection
- `BrainstormError` — Typed error hierarchy
- `logger` — Pino logger instance

## Usage

```typescript
import {
  type TaskProfile,
  type ModelEntry,
  formatTurnContext,
} from "@brainst0rm/shared";
```
