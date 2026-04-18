# Live-backend e2e harness

Playwright tests that drive the actual Electron binary against a real
`brainstorm ipc` child process. **No mocks.** Complements the mocked
suite in `../tests/` — mocked tests prove the renderer renders, these
prove the whole product works.

## Three tiers

The reliability harness follows a three-tier shape modeled on
`anthropics/claude-agent-sdk-python`'s discipline: protocol → contract
→ flow. Every tier runs against real code, never mocks.

| tier         | where                  | runner     | speed | what it proves                                                 |
| ------------ | ---------------------- | ---------- | ----- | -------------------------------------------------------------- |
| **protocol** | `tests-protocol/`      | vitest     | <1s   | wire-format primitives (NDJSON, event shapes, ready semantics) |
| **flow**     | `tests-live/*.spec.ts` | playwright | 5–90s | user journeys end-to-end against real Electron + real backend  |
| **repro**    | `tests-live/_repro/`   | playwright | 1–90s | incident-named regression traps for bugs the harness has fixed |

Every tier runs real code. Nothing is mocked. Add to whichever tier
matches the contract you're guarding:

- Is it a pure function over wire-format data? → **protocol.**
- Does it map to a past incident? → **repro**, named `repro-<incident>.live.spec.ts`.
- Does it exercise a full user journey? → **flow.**

## Run

```bash
# From apps/desktop:
npm run test:protocol   # fast, <1s, vitest unit tests
npm run test:live       # full live suite, ~4-5 min
```

The `webServer` config auto-starts Vite on `:1420` (reuses if already
running). The tests put `@brainst0rm/cli`'s workspace bin ahead of the
user's PATH so the child process is the Node CLI, not a Python
homonym.

Live tests that need DB isolation set `BRAINSTORM_HOME` to a fresh
tmpdir via `launchBrainstormApp()` — see `_helpers.ts`. This is
supported by `packages/db/src/client.ts`'s env override. Production
users never set it; the default `~/.brainstorm` is authoritative.

## Current coverage

**Protocol tier** — 18 unit tests, ~240ms total.
`tests-protocol/ipc-protocol.test.ts` covers `normalizeChatEvent`,
`parseBackendLine`, `isBackendReadyMessage`, `isStreamingEvent` —
the pure primitives in `src/lib/ipc-protocol.ts` that the full
renderer and main-process paths depend on.

**Flow + repro tiers** — 13 live tests, ~5 min total.

| file                                                      | tier  | traps                                                                                                      |
| --------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `boot.live.spec.ts`                                       | flow  | preload loading, CSP, backend-ready race, ESM interop, window-picker-vs-devtools race                      |
| `chat.live.spec.ts`                                       | flow  | env→1Password key resolution, IPC↔useChat event shape, streaming pipeline                                  |
| `conversation-persistence.live.spec.ts`                   | flow  | `conversationId` Zod strip (audit H2), MessageRepository persistence, rehydrate-on-select                  |
| `mode-sweep.live.spec.ts`                                 | flow  | any view crashing on mount; renderer pageerror accumulator                                                 |
| `model-switch.live.spec.ts`                               | flow  | activeModelId propagation (audit H5/F5), status-rail state wiring                                          |
| `backend-crash.live.spec.ts`                              | flow  | `sendToBackend` queueing across respawn; auto-respawn; turn-1 survives the crash                           |
| `abort.live.spec.ts`                                      | flow  | Stop button actually reaches the backend (audit H1/S4); stream genuinely stops                             |
| `abort-drain.live.spec.ts`                                | flow  | session isn't poisoned by abort — next turn completes (Vercel AI / Claude Agent SDK buffer-drain warning)  |
| `teardown.live.spec.ts`                                   | flow  | no orphan `brainstorm ipc` child processes survive `app.close()`                                           |
| `_repro/repro-event-shape-mismatch.live.spec.ts`          | repro | `{id,event,data}` → `{type,...}` normalize at bridge — end-to-end chat text lands                          |
| `_repro/repro-sendtobackend-drop-on-respawn.live.spec.ts` | repro | post-kill write hits queue, flushes on `{type:"ready"}` — narrow version of backend-crash                  |
| `_repro/repro-ipc-env-only-key-resolution.live.spec.ts`   | repro | ipc command pulls keys through vault resolver chain, not env-only (skipped w/o `OP_SERVICE_ACCOUNT_TOKEN`) |
| `_repro/repro-preload-cjs-missing.live.spec.ts`           | repro | build:electron actually produces `electron/dist/preload.cjs` with the expected bridge methods              |

## Flake budget

Live tests get **1 global retry** (`playwright.live.config.ts`).
Reason: under suite load (10+ back-to-back Electron launches with
sqlite-backed child processes) the OS process table + renderer
helpers occasionally crash a single test. Playwright's retry absorbs
the flake; two retries failing in a row flags a genuine regression.

If a test crosses this budget repeatedly, fix the test — don't raise
retries. Every retry masks information.

## Bugs the harness has caught

- **Silent `sendToBackend` drop during respawn** (caught in pass 3, fixed
  same commit). Before: messages that arrived during the 2s respawn gap
  were written to a null stdin and dropped. After: bounded queue
  flushes on `{type:"ready"}`.
- **Phantom "drain-after-interrupt" hang** — pass 4 suspected the
  Vercel AI / Agent SDK buffer-drain warning applied; pass 5's
  dedicated trap proved otherwise. Real root cause: sending a new turn
  before the UI settles out of `isProcessing=true` silently no-ops via
  the `if (isProcessing) return;` guard in useChat.send. Not a
  renderer bug — a UX one. Future pass: add a visible "aborting…"
  transient state so users don't type into a disabled send path.

## Deliberately-not-yet-covered patterns

These are drawn from a research pass through `anthropics/claude-agent-sdk-python`,
`vercel/ai`, and official Claude Code docs. Each has a specific line-reference and
a concrete failure mode we should trap eventually. Do not delete without reading
the rationale.

### Pass 6 candidates (highest remaining signal)

**NDJSON framing torture.** Spawn `brainstorm ipc` directly, pipe crafted
stdout lines across: two objects on one line, embedded `\n` in a JSON
string, a single 50KB object split into 3 chunks, an oversize
incomplete buffer. Asserts frame ordering + count. Ref:
[`test_subprocess_buffering.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/tests/test_subprocess_buffering.py).

**`stopWhen` / step-cap invariant.** Pattern uses a model or mock that
keeps calling tools; asserts exactly N steps, `finishReason`
progression, and `onStepFinish` firing once per step. Traps the
off-by-one and infinite-loop family that currently only shows up in
production. Ref:
[`stop-condition.test.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stop-condition.test.ts).

**Tool-call abort propagation.** Send a prompt that triggers a
long-running Bash / Docker sandbox tool call, abort, assert the
child PID dies within N seconds and no `PostToolUse` event fires for
it. Vercel AI has direct coverage of the abort-signal→tool-execute
contract. Ref:
[Vercel AI `stream-text.test.ts` lines 12911–12955](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text.test.ts).

**Permission-mode switch mid-stream.** Start in `default`, trigger a
write, see prompt; flip to `acceptEdits` via IPC; next write goes
through without prompt. Traps stale permission caches in preload.
Ref:
[`code.claude.com/docs/en/agent-sdk/permissions`](https://code.claude.com/docs/en/agent-sdk/permissions).

**Session fork + resume identity.** Complete 3 turns → kill →
relaunch-with-resume → assert exact transcript match. Fork from
message 2 → assert new session id, parent messages up to fork
point preserved, UUIDs remapped. Ref:
[`test_session_mutations.py#L620`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/tests/test_session_mutations.py#L620).

**Rate-limit / retry surface.** Inject a 429 through a dev backdoor on
BrainstormRouter, assert a recoverable state (not a crash), assert the
retry streams cleanly. Ref:
[Vercel AI `stream-text.test.ts` line 2212 `describe('retries')`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text.test.ts).

**Orphan-process cleanup.** _Landed in pass 5 via `_helpers.ts`
`closeCleanly()` + `teardown.live.spec.ts`._ Every live spec now
asserts no `brainstorm ipc` child survives `app.close()`.

**Previous-turn durability across crash.** _Partially landed in pass 5_
— `backend-crash.live.spec.ts` now sends a unique marker as turn-1
and asserts that marker is still in the transcript after the crash +
recovery. Still open: a direct DB assertion (opening sqlite from the
test, querying `messages` by session_id, asserting the row is there).
Worth adding once we need the evidence the DB write path itself is
durable beyond what the DOM proves.

### Architectural gotchas to keep in mind

- **Stdin closed before MCP handshake completes** — query starts before
  server ready.
  [Issue #817](https://github.com/anthropics/claude-agent-sdk-python/issues/817).
- **Hardcoded 60s init timeout bypassing user config.** Verify our
  `brainstorm ipc` boot path doesn't have the same pattern.
  [Issue #741](https://github.com/anthropics/claude-agent-sdk-python/issues/741).
- **CLI hangs indefinitely after successful tool call during synthesis.**
  No progress-timeout.
  [Issue #701](https://github.com/anthropics/claude-agent-sdk-python/issues/701).
- **`control_cancel_request` silently ignored → hook desync.** Parallel
  to our R1 "hooks frozen at crash-time" finding.
  [Issue #739](https://github.com/anthropics/claude-agent-sdk-python/issues/739).
- **Subagent inheritance of `bypassPermissions`** — once parent is
  permissive, children are too, unoverridable. Relevant to our
  sub-agent dispatch path.

## Adding a new live spec

1. Copy the window-picker + mainLog boilerplate from `chat.live.spec.ts`.
2. Prefer `getByTestId` over text/role locators — text changes silently.
3. On any assertion timeout, dump DOM + captured logs to stderr before
   throwing; fail messages must be actionable.
4. Run your new spec alone first (`npx playwright test --config
tests-live/playwright.live.config.ts <name>`), then with the full
   suite to catch cross-test interference.
5. If it catches a real bug, fix the bug in the same commit as the test
   — a green test without the fix is worse than no test.
