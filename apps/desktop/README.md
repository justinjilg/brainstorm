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
  │     ├── 22 allowed methods (allowlist enforced)
  │     ├── Zod param validation on all methods
  │     ├── request/response for CRUD
  │     └── streaming for chat events
  │
  └── Renderer (React + Tailwind + Catppuccin Mocha)
        ├── 10 views (Chat, Dashboard, Models, Memory, Skills, Security, Config, Plan, Trace, Workflows)
        ├── Content Security Policy (script-src 'self')
        ├── Keyboard shortcuts (Cmd+1-8 modes, Cmd+K palette, Cmd+D inspector)
        └── 79 Playwright tests
```

## Prerequisites

- Node.js 22+
- `brainstorm` CLI installed globally: `npm install -g @brainst0rm/cli`
- At least one LLM API key configured (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, etc.)

## Development

```bash
# Install dependencies (from monorepo root)
npm install
npx turbo run build

# Web mode (browser at localhost:1420)
cd apps/desktop && npm run dev

# Electron mode (native desktop app)
cd apps/desktop && npm run dev:electron

# Run Playwright tests (79 tests)
cd apps/desktop && npm run test

# Run CLI tests including IPC integration tests (180 tests)
cd packages/cli && npx vitest run
```

## Building a DMG

```bash
# Build unsigned (for development)
cd apps/desktop && npm run dist:unsigned

# Build signed (requires Developer ID certificate)
cd apps/desktop && npm run dist

# Build signed + notarized (requires Apple API key)
export APPLE_API_KEY_ID=<key-id>
export APPLE_API_ISSUER=<issuer-id>
export APPLE_API_KEY_PATH=<path-to-.p8-file>
cd apps/desktop && npm run dist
```

The DMG is output to `apps/desktop/release/Brainstorm-{version}-arm64.dmg`.

## Views

| View      | Status  | Description                                                       |
| --------- | ------- | ----------------------------------------------------------------- |
| Chat      | Working | Send messages, streaming responses, tool calls, cost tracking     |
| Dashboard | Working | 51 tools grouped by category, health stats, cost                  |
| Models    | Working | Real models from backend + fallback data, compare mode            |
| Memory    | Working | CRUD with tiers (system/archive/quarantine), trust scores         |
| Skills    | Working | 29 skills loaded from backend, toggle activation for chat context |
| Security  | Working | Red team engine, 8-layer middleware pipeline                      |
| Config    | Working | Real config from config.toml (budget, daemon, routing)            |
| Plan      | Working | Multi-phase workflow execution via preset workflows               |
| Trace     | Working | Live event stream from chat (routing, tool calls, errors)         |
| Workflows | Working | Preset workflow definitions from backend, run workflows           |

## Security

- `contextIsolation: true`, `nodeIntegration: false`
- Content Security Policy: `script-src 'self'` (prevents XSS)
- IPC method allowlist (22 methods) — arbitrary method calls rejected
- Zod param validation on all IPC methods (12 schemas, 22 unit tests)
- Config responses scrubbed of API keys before reaching renderer
- Preload bridge exposes minimal surface: `request`, `chatStream`, `onChatEvent`, `openFolder`
- npm audit: 0 vulnerabilities

## Failure Handling

- **Backend auto-respawn**: If the `brainstorm ipc` process crashes, the Electron main process automatically respawns it (max 3 retries, 2s delay between attempts)
- **Pending promise cleanup**: All in-flight IPC requests are rejected immediately when the backend exits (no 30s timeout hang)
- **Stream timeout**: Chat streams have a 5-minute timeout to prevent permanent UI freeze
- **Retry exhaustion**: After 3 failed respawn attempts, the UI shows a permanent error banner: "Backend failed to start after 3 attempts. Please restart the application."
- **Graceful stdin close**: The IPC handler waits for all pending dispatches to complete before exiting

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

All pino logs are redirected to stderr in IPC mode to prevent NDJSON protocol corruption.

## Test Coverage

| Layer           | Tests   | What it proves                                           |
| --------------- | ------- | -------------------------------------------------------- |
| IPC validation  | 22      | Zod schemas reject malformed params                      |
| IPC integration | 23      | Real `brainstorm ipc` backend responds correctly         |
| Playwright      | 79      | UI renders, interacts, and recovers from errors          |
| CLI components  | 135     | TUI components render and handle input correctly         |
| Core            | 150     | Middleware, skills, memory, semantic search, compaction  |
| Router          | 63      | Routing strategies, cost tracking, classifier            |
| Tools           | 80      | Tool registry, permissions, GitHub integration           |
| Workflow        | 31      | Confidence extraction, escalation, preset validation     |
| Agents          | 20      | NL parser, role-skill mapping                            |
| Config/DB/etc   | 50      | Schema validation, migrations, error classes, model data |
| **Total**       | **653** |                                                          |

## Known Limitations

- Context % gauge requires agent loop to emit `context-budget` events
- No auto-update mechanism (Sparkle/electron-updater not configured)
- Trace events are live-only (not persisted across sessions)
