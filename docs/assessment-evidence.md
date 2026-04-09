# Assessment Evidence — Brainstorm Desktop App (2026-04-08 reassessment)

Previous score: 3.2/10 → 4.0/10. This is the third assessment.

## Code Inventory

| Package               | Source Lines | Test Lines | Notes                             |
| --------------------- | ------------ | ---------- | --------------------------------- |
| packages/cli          | 15,308       | 1,987      | 13 test files, 170 tests passing  |
| packages/core         | 18,745       | 2,069      | 9 test files, 149 pass / 1 fail   |
| packages/shared       | 1,197        | 0          | No tests                          |
| packages/config       | 849          | ~200       | 1 test file, 10 tests passing     |
| packages/db           | 1,756        | ~300       | 1 test file, 9 tests passing      |
| packages/router       | 2,135        | 0          | No tests                          |
| packages/tools        | 7,051        | 0          | No tests in vitest                |
| packages/providers    | 1,168        | 0          | No tests                          |
| packages/godmode      | 4,460        | 0          | No tests                          |
| packages/workflow     | 1,498        | 0          | No tests                          |
| packages/agents       | 1,102        | 0          | No tests                          |
| apps/desktop/src      | 8,956        | 0          | React frontend                    |
| apps/desktop/electron | 326          | 0          | Electron main process             |
| apps/desktop/tests    | 0            | 1,537      | 6 Playwright spec files, 79 tests |
| **TOTAL**             | **~64,000**  | **~6,000** |                                   |

## Test Results

### CLI (170 tests — ALL PASS)

- 22 IPC validation tests (Zod schema verification)
- 13 IPC integration tests (real `brainstorm ipc` child process)
- 20 SelectPrompt component tests
- 16 keybinding tests
- 15 input history tests
- 14 ModeBar tests
- 12 ToolCallDisplay tests
- 10 ShortcutOverlay tests
- 6 mode roundtrip integration tests

### Core (149 pass / 1 fail)

- 1 FAIL: `skills-loader.test.ts > buildRepoMap > ranks index files higher` (pre-existing)

### Config (10 pass), DB (9 pass)

### Playwright (79 pass — ALL PASS)

- 39 DOM/interaction, 13 data flow, 7 error state, 8 state sync, 6 journey, 9 crash resilience

## Wiring Audit

### IPC Handler — 24 case branches for 22 allowed methods

Methods with integration tests (real backend): health, tools.list, memory.list, memory.delete (validation), skills.list, models.list, conversations.list, config.get, kairos.status, workflow.presets, unknown method rejection, invalid params rejection, wrong types rejection, rapid sequential requests.

Methods NOT integration tested: kairos.start/stop/pause/resume, chat.abort, security.redteam, workflow.run, memory.create/update (validation tested only), conversations.create/fork/handoff/messages (validation tested only).

### Desktop View Wiring

- 9/10 views import ipc-client and use real data
- TraceView (1/10) does NOT import ipc-client — receives events via App.tsx props only
- ChatView always mounted (display: contents/none CSS toggle)
- activeSkills lifted from SkillsView to App.tsx

### Electron Main Process

- Backend spawned as child process: `brainstorm ipc`
- backendReady set true only on stderr "ready" or successful response
- Auto-respawn: 3 retries, 2s delay, resets on success
- Pending cleanup: all promises rejected on backend exit
- Stream timeout: 5-minute cap prevents permanent UI freeze
- IPC allowlist: 22 methods

## Security Features

- IPC method allowlist: 22 methods, unknown rejected
- Zod param validation: 12 schemas, 22 unit tests
- Config secret scrubbing: strips /key|secret|token/i
- Pino→stderr in IPC mode
- contextBridge isolation, nodeIntegration: false, contextIsolation: true

## Build & Distribution

- Vite build: ✓ (1.1MB JS, 36KB CSS)
- Electron main compile: ✓
- DMG (unsigned): ✓ Brainstorm-0.1.0-arm64.dmg (112 MB)
- DMG (signed): ✗ (Apple timestamp server timeout)
- Notarization: ✗ (not configured)

## Git Log (last 20)

```
8620c02 feat(desktop): Electron app with IPC backend — 4.0/10 → targeting 7.0
3cb51ec fix(desktop): replace alert() with in-app hint banner
1989823 fix(desktop): 14 broken interactions fixed
611e30b feat(desktop): drag-and-drop skills onto agents
79193de feat(desktop): wire Tauri dialog plugin
16b1493 fix(desktop): un-suppress all state setters
27e00dd fix(desktop): remove process.env.HOME crash
...
```

## Production State

- LOCAL ONLY (Electron desktop app, not deployed)
- CLI v0.14.0 installed locally
- Chat E2E proven: real message → DeepSeek V3 → streaming response → $0.001

## Known Issues

1. Core skills-loader test fails (pre-existing)
2. TraceView not wired to ipc-client
3. Code signing timeout
4. kairos.start/stop/pause/resume not integration tested
5. security.redteam, workflow.run not integration tested
6. 9 packages have zero test files
7. Pino logger in IPC mode: `process.argv.includes('ipc')` check happens at module load — works because Node.js has argv populated before any imports execute
