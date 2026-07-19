# Iteration 008 — Result: relax channel coordinator to per-conversation concurrency

## Context
The channel coordinator serialized ALL agent runs onto one process-global tail (`globalRunTail`),
so even unrelated conversations never overlapped. That was necessary only because `runAgentLoop`'s
loop state (task store, transactions, checkpoints, tool-health, file-tracker, and the task/tool/
background event-handler registrations) was process-global. iter-005 made all of that session-scoped;
the iter-006 concurrency-isolation audit then confirmed **prerequisite 1** (no remaining cross-session
mutable globals) was satisfied and identified **prerequisite 2**: the loop *selects* its session via
`enterSession()` = `AsyncLocalStorage.enterWith()`, which by its own docstring does NOT isolate
concurrent runs that share an async context. This iteration lands prerequisite 2 and relaxes the
serialization.

## Shipped
### Concurrency-safe session selection (prerequisite 2)
Every caller that can drive loops **concurrently with different session ids** now consumes the loop
inside `withSession(sessionId, …)` (`AsyncLocalStorage.run` — saves and restores, unlike the loop's
bare `enterWith`), so each concurrent run resolves `getSessionId()` to its own session:
- **channels coordinator** — the relaxation target.
- **server** `/chat` + `/chat/stream` — concurrent HTTP requests.
- **sdk** `.run()` — an embedder may call `chat()` concurrently for different sessions on one instance.
- **eval runner** — nested inside its existing `withWorkspace` scope.

The loop's internal `enterSession` stays as a bare-`enterWith` fallback for standalone callers.

### Coordinator relaxation
`globalRunTail` (one tail serializing everything) → a **per-conversation `runTails` map** keyed by
`conversationKey` (`channelType + teamId + channelId + threadKey` — the same tuple the session store
binds on). Same conversation still serializes in arrival order; different conversations run
concurrently. The map is module-level (same conversation serializes even across coordinator instances,
matching the conversation-keyed session binding) and tails **self-evict once settled** to bound it.

## Caller inventory (why each is or isn't wrapped)
| caller | concurrent loops, diff sessions? | treatment |
|---|---|---|
| channels coordinator | YES (now relaxed) | `withSession` wrap + per-conversation tail |
| server chat / chat-stream | YES (HTTP) | `withSession` wrap |
| sdk `.run()` | possible (embedder) | `withSession` wrap |
| eval runner | sequential probes, but cheap + consistent | `withSession` inside `withWorkspace` |
| workflow engine | NO (steps sequential per run; it's a generator that `yield`s, can't wrap a for-await+yield in a callback) | internal `enterSession` (correct) |
| CLI interactive (`brainstorm.ts`) | NO (single-user, one loop at a time) | internal `enterSession` |
| CLI IPC daemon tick / chat | NO (local single-user; daemon tick is a `yield*` generator) | internal `enterSession` |

## Gate
- Old `serializes across different threads (global loop state)` test → replaced by **`runs different
  conversations concurrently`** (both start before either ends) + **`routes each concurrent run's loop
  to its own session scope`** (`getSessionId()` inside each interleaved run resolves to ITS session —
  fails without the `withSession` wrapper). Same-conversation serialization test retained.
- channels 83 + server 43 + sdk 17 + eval green; typecheck green; `as-any` 295/295.
- Builds on the iter-008 tools-level guard proving ALS isolation survives interleaved awaits.

## Net
Different conversations/requests now run concurrently and safely; only same-conversation messages
serialize. The coordinator's global bottleneck — the last artifact of process-global loop state — is
gone, and the change is guarded by tests that would fail if session isolation broke under concurrency.

## Deliberately NOT done
- Wrapping the workflow-engine and CLI generators: they don't drive concurrent loops sharing a context,
  and forcing `withSession` into a `for await`+`yield` generator would require restructuring (event
  queue) for zero concurrency benefit. Their internal `enterSession` is correct. If concurrent
  *workflow runs* in one process ever become a goal, that restructure is the follow-up.
