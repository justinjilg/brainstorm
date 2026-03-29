# @brainst0rm/hooks

Lifecycle hook system for automation. Hooks fire on events and can run shell commands with variable expansion.

## Key Exports

- `HookManager` — Register and fire hooks
- `createAutoLintHooks()` — Built-in auto-lint hook for file writes

## Events

PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit, PreCompact, Notification, SubagentStart, SubagentStop, PostShell

## Variable Expansion

- `$FILE` — The file path being operated on
- `$TOOL` — The tool name being called

## Usage

```typescript
import { HookManager } from "@brainst0rm/hooks";

const hooks = new HookManager();
hooks.register("PostToolUse", {
  command: "eslint --fix $FILE",
  match: "file_write",
});
```
