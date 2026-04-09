# Brainstorm Desktop

Multi-model agent orchestration desktop app. Built with Electron + React 19.

## Architecture

```
Electron Main Process
  ├── Spawns `brainstorm ipc` child process (Node.js)
  │     ├── Agent loop (@brainst0rm/core)
  │     ├── Model routing (@brainst0rm/router)
  │     ├── 51 tools (@brainst0rm/tools)
  │     ├── SQLite persistence (@brainst0rm/db)
  │     └── Memory manager (@brainst0rm/core)
  │
  ├── IPC Bridge (NDJSON over stdio)
  │     ├── request/response for CRUD
  │     └── streaming for chat events
  │
  └── Renderer (React + Tailwind + Catppuccin Mocha)
        ├── 10 views (Chat, Dashboard, Models, Memory, Skills, Security, Config, Plan, Trace, Workflows)
        ├── Keyboard shortcuts (Cmd+1-8 modes, Cmd+K palette, Cmd+D inspector)
        └── 79 Playwright tests
```

## Prerequisites

- Node.js 22+
- `brainstorm` CLI installed globally: `npm install -g @brainst0rm/cli`
- At least one LLM API key configured (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, etc.)

## Development

```bash
# Web mode (browser at localhost:1420)
npm run dev

# Electron mode (native desktop app)
npm run dev:electron

# Run tests
npm run test
```

## Views

| View      | Status      | Description                                                        |
| --------- | ----------- | ------------------------------------------------------------------ |
| Chat      | Working     | Send messages, streaming responses, tool calls, cost tracking      |
| Dashboard | Working     | 51 tools grouped by category, health stats, cost                   |
| Models    | Working     | Real models from backend + fallback data, compare mode             |
| Memory    | Working     | CRUD with tiers (system/archive/quarantine), trust scores          |
| Skills    | Working     | 29 skills loaded from backend, toggle activation                   |
| Security  | Working     | Red team engine, 8-layer middleware pipeline                       |
| Config    | Working     | Real config from config.toml (budget, daemon, routing)             |
| Plan      | In Progress | Multi-phase workflow execution (wired to backend, needs UI polish) |
| Trace     | In Progress | Live event stream from chat (routing, tool calls, errors)          |
| Workflows | In Progress | Preset workflow definitions from backend                           |

## Security

- `contextIsolation: true`, `nodeIntegration: false`
- IPC method allowlist (22 methods) — arbitrary method calls rejected
- Config responses scrubbed of API keys before reaching renderer
- Preload bridge exposes minimal surface: `request`, `chatStream`, `onChatEvent`, `openFolder`

## IPC Protocol

The Electron main process communicates with the `brainstorm ipc` child process via NDJSON over stdio:

```
→ stdin:  {"id":"1","method":"tools.list","params":{}}
← stdout: {"id":"1","result":[...]}

→ stdin:  {"id":"2","method":"chat.stream","params":{"message":"hello"}}
← stdout: {"id":"2","event":"routing","data":{...}}
← stdout: {"id":"2","event":"text-delta","data":{"delta":"Hello"}}
← stdout: {"id":"2","event":"stream-end","data":{}}
```

## Known Limitations

- Chat messages are not persisted across conversation switches (local React state)
- Context % gauge requires agent loop to emit `context-budget` events
- Plan/Trace/Workflows views are functional but need polish
- No auto-update mechanism yet
- No code signing (development builds only)
