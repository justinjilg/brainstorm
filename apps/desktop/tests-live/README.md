# Live-backend e2e harness

Playwright tests that drive the actual Electron binary against a real
`brainstorm ipc` child process. **No mocks.** Complements the mocked
suite in `../tests/` — mocked tests prove the renderer renders, these
prove the whole product works.

## Run

```bash
# From apps/desktop:
npm run test:live
```

The `webServer` config auto-starts Vite on `:1420` (reuses if already
running). The tests put `@brainst0rm/cli`'s workspace bin ahead of the
user's PATH so the child process is the Node CLI, not a Python
homonym.

## Current coverage (7 tests, ~2.4 min end-to-end)

| file                                    | traps                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `boot.live.spec.ts`                     | preload loading, CSP, backend-ready race, ESM interop, window-picker-vs-devtools race     |
| `chat.live.spec.ts`                     | env→1Password key resolution, IPC↔useChat event shape, streaming pipeline                 |
| `conversation-persistence.live.spec.ts` | `conversationId` Zod strip (audit H2), MessageRepository persistence, rehydrate-on-select |
| `mode-sweep.live.spec.ts`               | any view crashing on mount; renderer pageerror accumulator                                |
| `model-switch.live.spec.ts`             | activeModelId propagation (audit H5/F5), status-rail state wiring                         |
| `backend-crash.live.spec.ts`            | `sendToBackend` queueing across respawn; auto-respawn; post-recovery chat                 |
| `abort.live.spec.ts`                    | Stop button actually reaches the backend (audit H1/S4); stream genuinely stops            |

## Bugs the harness has caught

- **Silent `sendToBackend` drop during respawn** (caught in pass 3, fixed
  same commit). Before: messages that arrived during the 2s respawn gap
  were written to a null stdin and dropped. After: bounded queue
  flushes on `{type:"ready"}`.

## Deliberately-not-yet-covered patterns

These are drawn from a research pass through `anthropics/claude-agent-sdk-python`,
`vercel/ai`, and official Claude Code docs. Each has a specific line-reference and
a concrete failure mode we should trap eventually. Do not delete without reading
the rationale.

### Pass 5 candidates (highest signal)

**Drain-after-interrupt.** The Vercel AI SDK and the Claude Agent SDK
both warn that after an interrupt, the session buffer holds an
`error_during_execution` ResultMessage that MUST be drained before the
next query, or stale tokens leak into the next bubble. Our current
`abort.live.spec.ts` scopes down to "Stop stops the backend" because
the follow-up-turn assertion fails — exactly the symptom these two
projects warned about. Follow-up work is a two-part task: drain in
`useChat` on the backend-aborted path, then a spec that asserts
Turn 2 after an abort completes cleanly. Refs:
[`claude-agent-sdk-python/tests/test_streaming_client.py#L484`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/tests/test_streaming_client.py#L484),
[Vercel AI `stream-text.test.ts` lines 3870–4186](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text.test.ts).

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

**Orphan-process cleanup.** `afterEach` assertion: `pgrep -f "brainstorm ipc"`
returns zero children after `app.close()`. Trivial to add; catches a
class of tear-down bug none of the current tests exercise.

**Previous-turn durability across crash.** Our current
`backend-crash.live.spec.ts` only asserts turn-2 works; it never
opens the DB and checks that turn-1's assistant message actually
persisted. Issue #625 in `claude-agent-sdk-python` was exactly this
class of bug.

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
