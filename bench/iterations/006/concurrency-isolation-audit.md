# Concurrency-Isolation Audit — can the channel coordinator relax its global serialization?

## Why this audit
`packages/channels/src/coordinator.ts` serializes ALL channel-driven agent runs onto one
process-global `globalRunTail` (coordinator.ts:58), so two messages — even in unrelated threads —
never overlap. An earlier attempt to relax this to per-conversation concurrency failed a test because
`file-tracker` and `tool-health` were still process-global singletons. Those are now session-scoped
(iter-005 commit b501377). This audit answers: is relaxing the serialization now safe?

**Answer: not yet — the store scoping is complete, but a SECOND prerequisite remains (below).**

## Prerequisite 1 — no cross-session mutable globals — SATISFIED
A full sweep of module-level mutable state across `packages/tools/src`, `packages/core/src`, and
`packages/router/src` (Explore audit + direct verification of the safety-critical items) found **zero
remaining cross-session hazards**. Every mutable module-level holder is one of:

- **Session-scoped** (keyed by `getSessionId()`, 256-entry LRU): task store, transaction, checkpoint,
  scratchpad, process-manage, file-tracker, tool-health, shell background tasks + shell
  background/tool-output event handlers.
- **Intentionally process-lifetime & safe**: shell sandbox config (`shell.ts:160-161`
  `currentSandboxLevel`/`currentProjectPath`, set once via `configureSandbox()` at CLI startup — a
  process-wide safety-net default, NOT a per-session authority mechanism; per-run authority is enforced
  separately through the injected `permissionCheck`), Docker sandbox singleton + pool, file-read cache
  (TTL), classifier cache (bounded LRU), rate limiter, learned-routing flywheel (explicitly
  process-global by design, injectable for tests).
- **Keyed by transient call-id or per-session instance** (not session-global): trust-propagation,
  secret-substitution scrub maps (callId + TTL), approval-friction (WeakMap on per-session tracker),
  fleet-signals (sessionId-keyed).

Safety-critical state (sandbox level, project path, permissions, secret redaction) is **not** exposed
to concurrent-session corruption.

## Prerequisite 2 — concurrency-safe session SELECTION — NOT SATISFIED
The stores are correctly keyed by session, but the mechanism that decides *which* session key a given
execution sees is not concurrency-safe. `runAgentLoop` (loop.ts:619) selects its session with
`enterSession(sessionId)`, which calls `AsyncLocalStorage.enterWith()` — chosen because the loop is a
generator and can't wrap its `yield`s in a `withSession()` callback.

`session-context.ts:34-48` documents the hazard on `enterSession` itself:
> CAUTION: `enterWith` sets the store for the current async execution and all nested continuations; it
> does NOT restore the previous id when this scope "exits"... When callers may share an async context
> across sessions, prefer `withSession(...)` over `enterSession`.

So if the coordinator relaxed to per-conversation concurrency, two loops driven concurrently and
sharing an async-context ancestor could clobber each other's `getSessionId()` via `enterWith` — the
session-keyed stores would then be read/written under the WRONG key. The global serialization is what
currently guarantees no two loops are ever in flight at once, which is why `enterWith` is safe today.

## What relaxing the coordinator actually requires (a dedicated iteration)
1. Drive the loop inside a real ALS scope: every caller of `runAgentLoop` (server, CLI, channels,
   workflow/engine, revise-loop, subagent) consumes the generator inside
   `withSession(sessionId, () => consume(...))` (i.e. `sessionStorage.run`), so each concurrent
   conversation gets an isolated context and `getSessionId()` resolves correctly under interleaving.
   `enterSession` can remain as a standalone/test fallback but stops being the isolation boundary.
2. Concurrency regression tests: two loops for different sessions interleaved must not cross-wire task
   event handlers, clear each other's tasks, or collide on ids — the exact scenarios the current global
   FIFO hides.
3. Only then relax `globalRunTail` to a per-conversation tail (keyed by
   channelType+teamId+channelId+threadKey), preserving same-thread ordering.

This is the same work as the plan's **005.6 #1 (per-run-vs-session two-key scope)** plus a caller-side
ALS-wrapping change. It is deliberate concurrency-correctness work with a safety-critical failure mode
(wrong-session store access) and must not be rushed — an earlier premature attempt was correctly
reverted. Recording it here so the next iteration starts from a proven characterization rather than
re-discovering it.
