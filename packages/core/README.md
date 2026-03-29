# @brainst0rm/core

The brain of Brainstorm — agent loop, session management, and intelligence features.

## Key Exports

- `runAgentLoop()` — Main loop using AI SDK v6 `streamText` with tool calling
- `SessionManager` — Conversation history and turn tracking
- `PermissionManager` — Permission modes (strict, normal, permissive)
- `compactContext()` — Context window management with scratchpad preservation
- `buildSystemPrompt()` — Construct system prompt with project context and tool awareness

## Intelligence

- `BuildStateTracker` — Tracks build/test results, injects persistent warnings
- `LoopDetector` — Detects repetitive tool call patterns (4+ reads, duplicates)
- `SessionPatternLearner` — Cross-session learning from tool usage patterns
- `ErrorFixTracker` — Records error → fix sequences for future reference
- `FileWatcher` — Detects external file changes via `fs.watch`
- `ReactionTracker` — Classifies user satisfaction signals
- `detectTone()` — Heuristic user sentiment detection

## Usage

```typescript
import { runAgentLoop } from "@brainst0rm/core";

for await (const event of runAgentLoop(options)) {
  // Handle: text, tool-call, tool-result, compaction-warning, loop-warning
}
```
