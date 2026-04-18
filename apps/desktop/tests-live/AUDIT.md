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

## Closed during reliability passes 10–24

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

### ✅ Permission-mode switch mid-stream — not applicable to our shape

- Source: [Claude Agent SDK permissions doc — "During streaming"](https://code.claude.com/docs/en/agent-sdk/permissions).
- Our status: audited in pass 15. The race doesn't apply.
- Evidence: our desktop app has no UI affordance to flip permission
  modes during a live turn. The `permissionMode` state in
  `apps/desktop/src/App.tsx` is declared with a leading underscore
  on the setter (`_setPermissionMode`) — never called. Permission
  mode is set on persona selection (before the turn starts) and
  stays fixed for the duration. The class of bug the SDK flags —
  stale permission caches surviving an `acceptEdits` flip — can't
  occur on a surface that doesn't expose the flip.
- Note: if we ever add a mid-stream permission control (Raycast-style
  "allow once / always / deny"), re-open this item. The audit is
  about the UI affordance, not the underlying `PermissionManager`.

### ✅ Session fork + handoff — IPC contract pinned

- Source: [SDK `test_session_mutations.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/tests/test_session_mutations.py).
- Our status: pinned in pass 14.
- Evidence: `tests-protocol/conversations-mutations.test.ts` exercises
  `conversations.fork` and `conversations.handoff` against the real
  `brainstorm ipc` subprocess. Three assertions:
  1. fork mints a fresh id, inherits settings, does NOT copy
     messages (intentional divergence from SDK `fork_session`,
     documented in the test).
  2. fork against an unknown id returns null.
  3. handoff updates `modelOverride` without creating a new row.
- Note: our fork intentionally does not preserve history. If we ever
  want SDK-parity `fork_session` semantics, the pinned test forces
  that to be a deliberate, reviewable change.

### ✅ Rate-limit / retry surface — handled at AI SDK layer

- Source: [Vercel AI `describe('retries')`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text.test.ts).
- Our status: implemented via `maxRetries: 3` passed to `streamText`.
- Evidence: `packages/core/src/agent/loop.ts` line 816 —
  `maxRetries: 3` with the comment "Retry on 429/503 with exponential
  backoff (1s, 2s, 4s). Without this, rate limits during long KAIROS
  runs crash the daemon." The AI SDK itself has the retries test
  suite the research cited; we inherit the behaviour. Additionally
  line 83 classifies rate-limit errors as model-API errors and
  records them in routing outcomes so bandit-learning avoids the
  rate-limited model going forward.
- Note: no dedicated live trap because we'd need a dev backdoor at
  the BR gateway to inject 429s deterministically. The SDK-layer
  test coverage is adequate for the common case; our layer's
  contribution is the routing-outcome recording, which is covered
  elsewhere by the router's learned-strategy tests.

### ✅ `stopWhen` / step-cap invariant — AI SDK primitive

- Source: [Vercel AI `stop-condition.test.ts`](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stop-condition.test.ts).
- Our status: uses the AI SDK's `stepCountIs(N)` primitive directly.
- Evidence: `packages/core/src/agent/loop.ts` line 817 —
  `stopWhen: stepCountIs(shouldUseTools ? (options.maxSteps ??
config.general.maxSteps) : 1)`. No custom step-cap logic; we
  inherit the AI SDK's tested behaviour. `maxSteps` is user-
  configurable in `brainstorm.toml` via `general.maxSteps`; per-
  agent overrides come through `agent.maxSteps`.
- Note: if we ever roll a custom stopWhen composite (e.g., "stop
  when N steps OR total tokens > M OR any tool errored"), re-open
  this item — custom logic needs its own test. The current single-
  condition `stepCountIs(N)` is table-stakes SDK usage.

### ✅ Pending IPC requests reject on backend exit (S6)

- Source: Apr-2026 adversarial review, S6 — `main.ts` `pending` map
  dropped callbacks on backend exit.
- Our status: fixed in pass 17.
- Evidence:
  - `apps/desktop/electron/main.ts` — `pending` now stores
    `{ settle, reject }` and the `exit` handler rejects every
    in-flight promise with `new Error("Backend process exited")`
    before clearing the map. `chat-stream`'s `doneKey` is stored as
    a no-op reject (backend-exit surfaces via the stream event path,
    not the one-shot promise).
- Note: no dedicated live trap — the fastest real backend response
  (sub-10ms) always beats any SIGKILL + 300ms-wait scheme, so the
  race can't be made deterministic in a live Playwright spec.
  Closed by inspection; the existing `repro-sendtobackend-drop-on-
respawn.live.spec.ts` already covers the sibling path (outbound
  queue across respawn).

### ✅ Partial reply flagged on mid-stream backend error (S5)

- Source: Apr-2026 adversarial review, S5 — provider `error` event
  arriving after some text-delta events finalized the bubble as a
  clean completion, masking truncation from the user.
- Our status: fixed in pass 18.
- Evidence:
  - `apps/desktop/src/hooks/useChat.ts` — `backendErrored` flag set
    in the `"error"` case; OR'd with `aborted` when finalizing so
    the existing "— stopped" UI path renders on both cancel and
    mid-stream error.
  - Pure helper extracted to `src/hooks/finalize-turn.ts` so the
    decision matrix is testable without mounting the hook.
  - Protocol trap: `tests-protocol/finalize-turn.test.ts` (7 cases)
    pins clean-complete, user-abort, backend-error, and both.

### ✅ Background shell task honours AbortSignal (S2)

- Source: Apr-2026 adversarial review, S2 — `background: true`
  branch dropped `ctx.abortSignal` on the floor; user Stop during a
  turn that spawned a bg task left the subprocess running until the
  10-minute timeout and the completion event never fired.
- Our status: fixed in pass 19.
- Evidence:
  - `packages/tools/src/builtin/shell.ts` background branch now
    mirrors the foreground onAbort handler (SIGTERM + 2s SIGKILL
    grace), bails out of the completion path with a non-zero exit,
    and detaches the listener on completion to avoid leaking
    listeners on per-session controllers that spawn many bg tasks.
  - Unit traps in `shell-abort.test.ts`:
    - mid-flight abort: spawn bg sleep, abort 200ms later, assert
      completion event arrives under 8s with non-zero exit and no
      pgrep survivor.
    - pre-aborted: controller already aborted when execute() runs.

### ✅ Docker sandbox hardening + default level flip (A1, pass 24)

- Source: v9 stochastic assessment's Attacker agent (1/10 but
  high-severity): pre-fix, the `docker run` invocation had no
  `--network`, no `--user`, no `--cap-drop`, no resource limits, and
  ran as root with bridge networking; separately, the shell module
  default was `"none"` so any caller that skipped `configureSandbox()`
  got unsandboxed execution.
- Our status: fixed in pass 24.
- Evidence:
  - `packages/tools/src/sandbox/docker-sandbox.ts` now passes
    `--network=none`, `--user=1000:1000`, `--cap-drop=ALL`,
    `--security-opt=no-new-privileges`, `--memory=2g --cpus=2
--pids-limit=256`; container name switched from predictable
    `Date.now()` to `randomUUID()`.
  - `packages/tools/src/builtin/shell.ts` module default flipped
    from `"none"` to `"restricted"`.
  - Trap: `shell-sandbox.test.ts` "blocks destructive commands
    without explicit configureSandbox()" — runs `shellTool.execute({
command: "rm -rf /" })` directly and asserts `blocked: true`.
    Reverting the default fails this test.
- Note: bind mount stays read-write because workspace editing is the
  core use case. The remaining escape surface (a compromised agent
  inside the container tampering with tracked files) is already in
  the trust model — this closes exfiltration, fork-bombs, root
  escalation, and prevents enumeration of container names.

### ✅ npx-fallback child gets full stdio wiring (S7, pass 21)

- Source: post-review re-audit of `main.ts` during pass 21.
- Our status: fixed.
- Evidence:
  - `apps/desktop/electron/main.ts` — a module-level `useNpxFallback`
    flag now gates command selection in `spawnBackend()`. On primary
    ENOENT the error handler flips the flag and calls `spawnBackend()`
    recursively so the fallback child goes through the same rl/stderr/
    exit wiring the primary would have.
- Previous bug shape: the old inline fallback reassigned `backend`
  to an npx child but left the readline, stderr listener, and exit
  handler bound to the now-dead primary's streams. A fresh-Mac DMG
  launch with `brainstorm` absent from PATH but `npx` present would
  spawn a working npx child that no one was reading stdout from —
  user saw a silent hang with no error banner, no respawn retries
  (per Node docs, ENOENT doesn't fire 'exit'), and no way to recover
  without relaunching.
- Note: no automated trap — exercising this path would require a
  fake npx that speaks our NDJSON protocol plus careful PATH
  manipulation inside the Playwright harness. Closed by inspection;
  the change is tiny, self-contained, and the `notifyCliMissing`
  banner still surfaces the failure if the npx fallback also ENOENTs.

### ✅ Send-guard race closed with ref (S4)

- Source: Apr-2026 adversarial review, S4 — `isProcessing` state
  closure could allow rapid double-send to bypass the guard.
- Our status: fixed in pass 20.
- Evidence:
  - `apps/desktop/src/hooks/useChat.ts` — `isProcessingRef` flipped
    synchronously before any async work; the public `isProcessing`
    state is still exported for UI (disable input, show spinner)
    but the ref is the re-entry gate.
  - Side-fix: `sessionCost` removed from useCallback deps (unused
    in the body; its presence churned `send`'s identity per cost
    tick and forced memoized parents to re-render).
- Note: no automated trap — this race lives inside React's state
  batching, and the project's vitest harness is node-environment
  only (no jsdom + RTL). Closed by inspection + the explicit ref
  comment; `chat.live.spec.ts` already covers the happy path.

## Notes for reviewers

- Every "✅" item here has at least one runnable trap OR a documented
  reason it's not applicable. If you change code that would silently
  break an invariant, a test fires before merge.
- If you come across a new failure mode:
  1. Find the public source (SDK issue, Vercel AI test, etc.) that
     flagged the same class.
  2. Add a section here with status + evidence.
  3. Land the trap in the same commit as the AUDIT.md entry.
- Don't add a new audit finding without a source citation. "I thought
  of this" isn't enough — if it was worth flagging, someone else hit it
  in production and the bug report is public.
