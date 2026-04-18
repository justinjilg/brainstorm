# Architectural gotcha audit

Public references flagged a set of architectural bugs the Claude Agent
SDK has hit in production. This file is the ground-truth map of where
each one lands in our code — whether it's already handled, partially
handled, or genuinely open. Every entry cites a repo/issue link so the
original shape is one click away.

Updated on each reliability pass. If you're adding a new audit finding,
put it here with the same shape: source → our status → source of
evidence (file path or test name).

## Audited items

### ✅ Chat abort reaches the backend

- Source: audit H1 / [SDK control_cancel_request desync](https://github.com/anthropics/claude-agent-sdk-python/issues/739).
- Our status: wired end-to-end.
- Evidence:
  - `apps/desktop/electron/main.ts` ipcMain handle for `chat-abort`
    forwards to backend via `sendToBackend`.
  - `packages/cli/src/ipc/handler.ts` `case "chat.abort"` aborts the
    in-flight `AbortController` and emits `stream-end`.
  - Live trap: `tests-live/abort.live.spec.ts`.

### ✅ Stream-stall watchdog

- Source: [SDK issue #701 — "CLI hangs indefinitely after successful tool call during synthesis"](https://github.com/anthropics/claude-agent-sdk-python/issues/701).
- Our status: hardcoded 60s watchdog in the agent loop.
- Evidence: `packages/core/src/agent/loop.ts` — `STREAM_TIMEOUT_MS = 60_000`.
  `watchdogFired` abort distinguishes watchdog-origin from user-origin
  aborts so stalled streams fall through to the RETRY_MODELS fallback
  chain instead of being reported as cancellations.
- Gap: the 60s threshold isn't user-configurable. Very long legit
  thinking (extended-thinking models emitting reasoning silently, very
  slow provider) could trip it. Low priority — no user has hit this.
  If one does, add a `config.agent.streamTimeoutMs` override and
  passthrough.

### ✅ `sendToBackend` queueing across respawn

- Source: found during reliability pass 3 (first live trap caught it).
- Our status: fixed + trapped.
- Evidence:
  - `apps/desktop/electron/main.ts` — `pendingOutbound` queue, capped
    at `MAX_PENDING_OUTBOUND`, flushed in the `{type:"ready"}` handler.
  - Live trap: `tests-live/_repro/repro-sendtobackend-drop-on-respawn.live.spec.ts`.

### ✅ Shell tool honours `AbortSignal`

- Source: [Vercel AI tool abort-signal contract](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text.test.ts).
- Our status: fixed in reliability pass 8.
- Evidence:
  - `packages/tools/src/builtin/shell.ts` `execute({...}, ctx)` now
    registers an abort listener that SIGTERMs the child then SIGKILLs
    after a 2s grace period. `{ once: true }` + explicit
    `removeEventListener` keep listener budget clean.
  - Unit trap: `packages/tools/src/__tests__/shell-abort.test.ts`
    (3 tests, <1s) covers mid-sleep abort, no-ctx, and pre-aborted.

### ✅ Subagent-tool forwards parent abort signal

- Source: SDK subagent cancellation contract.
- Our status: wired.
- Evidence:
  - `packages/core/src/agent/subagent-tool.ts` — execute() spreads
    `parentSignal: ctx?.abortSignal` into SubagentOptions; spawnSubagent
    and spawnParallel both receive it.

### ✅ Ready signal race between backend and window

- Source: found during reliability pass 6 audit.
- Our status: fixed with sticky flag + `getBackendReady` poll.
- Evidence:
  - `apps/desktop/electron/main.ts` — emits `{type:"ready"}` forward to
    every window; re-fires on `did-finish-load` if `backendReady` is
    already true.
  - `apps/desktop/src/hooks/useBackendReady.ts` polls the sticky state
    on mount to absorb the React-subscribe-after-emit race.
  - Live trap: implicit in `tests-live/boot.live.spec.ts`.

### ✅ NDJSON framing tolerates adversarial stdin

- Source: [SDK `test_subprocess_buffering.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/tests/test_subprocess_buffering.py).
- Our status: verified against the real `brainstorm ipc` subprocess.
- Evidence: `tests-protocol/ndjson-framing.test.ts` — 6 cases covering
  ready-signal shape, single-frame response, mid-stream garbage, line-
  concat, chunked writes, and clean stdin-close exit.

### ✅ Event shape `{event,data}` → `{type,...}` bridge

- Source: found in reliability pass 4 (mocked Playwright couldn't catch it).
- Our status: fixed + double-trapped.
- Evidence:
  - `apps/desktop/src/lib/ipc-protocol.ts` `normalizeChatEvent` with
    documented contract. Type can't be spoofed by payload keys.
  - Protocol traps: `tests-protocol/ipc-protocol.test.ts` (7 cases).
  - Live trap: `tests-live/_repro/repro-event-shape-mismatch.live.spec.ts`.

### ✅ Orphan `brainstorm ipc` child after window close

- Source: flagged by the research as a tear-down assertion nobody had.
- Our status: every live spec asserts it via `closeCleanly()`.
- Evidence: `tests-live/_helpers.ts` `assertNoOrphanBackends()`, plus
  the standalone sentinel at `tests-live/teardown.live.spec.ts`.

## Open items

### ✅ Previous-turn durability — direct sqlite readback

- Source: [SDK issue #625 — session file not flushed before subprocess termination](https://github.com/anthropics/claude-agent-sdk-python/issues/625).
- Our status: trapped at DB level in pass 10.
- Evidence: `tests-live/_repro/repro-crash-db-durability.live.spec.ts`
  opens `$BRAINSTORM_HOME/brainstorm.db` readonly after the app
  closes and asserts BOTH the marker user row and at least one
  assistant row for the session exist. Stricter than the DOM check
  in `backend-crash.live.spec.ts` because it proves the persistence
  path actually reached disk.

### ✅ `config.agent.streamTimeoutMs` is configurable

- Source: the stream-stall watchdog was hardcoded at 60s.
- Our status: fixed in pass 11.
- Evidence: `packages/config/src/schema.ts` now declares
  `agent.streamTimeoutMs` (positive integer, default 60_000).
  `packages/core/src/agent/loop.ts` reads
  `options.config.agent?.streamTimeoutMs ?? 60_000`. Extended-thinking
  models can raise it via `[agent] streamTimeoutMs = N` in
  `brainstorm.toml`.

### ✅ MCP handshake stdin timing — not applicable to our shape

- Source: [SDK issue #817](https://github.com/anthropics/claude-agent-sdk-python/issues/817).
- Our status: audited in pass 12. The race doesn't apply here.
- Evidence: `packages/mcp/src/client.ts` connectAll awaits both
  `createMCPClient({ transport })` and the subsequent `client.tools()`
  call before registering each tool with the registry. `.tools()` is
  the first server call and implicitly completes the initialize
  handshake — no ambient request can race past it. Separately, the
  desktop `brainstorm ipc` command doesn't call `connectMCPServers`
  at all today; MCP is wired only in the interactive `chat` / `run`
  commands where `connectAll` is awaited by the startup orchestrator.
- Note: if a future IPC mode adds MCP support, re-run this audit —
  the safety property relies on `connectAll` being awaited before
  the agent loop starts.

### ⚠️ Permission-mode switch mid-stream

- Source: [Claude Agent SDK permissions doc — "During streaming"](https://code.claude.com/docs/en/agent-sdk/permissions).
- Current coverage: `PermissionManager` lives in
  `packages/core/src/permissions/manager.ts` but I haven't verified
  that switching modes during a live turn invalidates cached approvals
  in the preload bridge.
- Follow-up: audit the permission-check call site in the agent loop,
  then add a live trap: start in `confirm`, send a tool-triggering
  prompt, flip to `auto`, assert the next tool call skips the prompt.

### ⚠️ Session fork + resume identity

- Source: [SDK `test_session_mutations.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/tests/test_session_mutations.py).
- Our status: `conversations.fork` and `conversations.handoff` IPC
  methods exist in `packages/cli/src/ipc/handler.ts`, but no renderer
  call sites use them today, and no test covers the identity contract
  (new session id, parent messages up to fork point preserved, UUIDs
  remapped).
- Follow-up: either wire a renderer entry point and add the test, or
  remove the IPC methods as dead code until a consumer appears.

### ⚠️ Rate-limit / retry surface

- Source: [Vercel AI `describe('retries')`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text.test.ts).
- Shape: 429 responses should trigger a typed retry and eventually
  stream the successful call.
- Current coverage: none — we don't have a dev backdoor that can
  inject 429s at the router layer.
- Follow-up: add a `BRAINSTORM_FORCE_429` env var to BR gateway /
  router dev mode, then a live trap that asserts the UI shows a
  recoverable state + second attempt streams.

### ⚠️ `stopWhen` / step-cap invariant

- Source: [Vercel AI `stop-condition.test.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stop-condition.test.ts).
- Shape: `stepCountIs(N)` off-by-one or infinite-loop guard.
- Current coverage: `packages/core/src/agent/loop.ts` uses
  `stopWhen: stepCountIs(N)` but no test validates the step counter
  across tool-call loops.
- Follow-up: unit test with a fake model that always requests one more
  tool call. Assert the loop terminates at N steps, `finishReason` is
  the step-limit variant, `onStepFinish` fires exactly N times.

## Notes for reviewers

- Every "✅" item here has at least one runnable trap. If you change the
  code that would silently break the invariant, a test fires before
  merge.
- Every "⚠️" item is legitimately open — we haven't built the trap, or
  we haven't fully audited the code path. A future reliability pass
  should pull items off this list top-down.
- Don't add a new audit finding without a source citation. "I thought
  of this" isn't enough — if it was worth flagging, someone else hit it
  in production and the bug report is public.
