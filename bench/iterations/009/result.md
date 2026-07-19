# Iteration 009 — Result: turn-tail background-completion mailbox (backlog 005.6 #5)

## Context
Backlog item 005.6 #5 flagged a possible gap: background jobs (shell `background:true`) that outlive the
turn that started them might lose their completion event once `runAgentLoop`'s `finally` nulls its
handlers. The iter-009 mandate was to determine whether this is a **live** problem *before* building
anything, since `shell.ts` already has a `pendingEventsBySession` replay mechanism.

## Assessment (live? — partially)
Traced the full lifecycle. There are two cases, and only one is broken:

- **Scenario A — job completes AFTER the turn's `finally` nulls the handler: already correct.**
  `emitCompletion` (shell.ts) captures the *originating* `bgSessionId`, finds no handler, and queues
  the event to `pendingEventsBySession[bgSessionId]`. The next turn in that session calls
  `setBackgroundEventHandler`, which **replays** the pending queue. Delivered next turn. No change needed.

- **Scenario B — job completes in the turn TAIL: LOST.** The window is *after* the loop's only
  `taskEventQueue` drain (`loop.ts:1371`, the tool boundary) but *before* the `finally` nulls the
  handler. That window **includes forced synthesis** — a full extra model call that can take seconds.
  In it, `emitCompletion` finds the handler still registered and delivers the event into the loop's
  per-turn `taskEventQueue`. But the loop never drains that queue again, it dies with the generator,
  and because a handler *was* present the event never fell through to `pendingEventsBySession`. Result:
  not shown this turn, not replayed next turn — dropped.

So the mailbox is a real (if narrow) gap, reachable precisely because this arc added forced synthesis.

## Shipped
- **`shell.ts`: `requeueBackgroundEvents(events, sessionId)`** — appends events to the session's pending
  queue (bounded by `MAX_PENDING_EVENTS = 100`) for replay to the next handler. `BackgroundEvent` type
  exported.
- **`loop.ts` `finally`:** after nulling the handler (which clears the session's pending queue), filter
  the leftover `background-complete` events out of `taskEventQueue` and hand them to
  `requeueBackgroundEvents`. This routes tail completions onto the same next-turn replay path Scenario A
  already uses. Task-created/updated events are turn-local UI and are intentionally not carried over.

## Gate
- **`shell-session-scope` (+5 deterministic):** requeue → next-handler replay; the full loss→fix
  sequence; per-session isolation; the `MAX_PENDING_EVENTS` bound; empty-set no-op.
- **`loop-background-delivery` (new, end-to-end):** drives the real loop, pauses in the synthesis window
  (deferred synthesis-text promise), injects a late completion into the loop's captured handler, and
  asserts the `finally` requeues it *and* the next turn in the same session replays it. Fails without
  the fix (requeue never called; event lost).
- core 629 + tools 242 green (the only 2 failures are Docker-integration tests failing on Docker Desktop
  org-auth — environmental); typecheck clean; `as-any` 295/295.

## Net
Background completions can no longer be silently dropped in the turn tail. Both job-outlives-turn cases
(post-finally and tail) now converge on one delivery path: the originating session's pending queue,
replayed on its next turn. The narrow race that forced synthesis introduced is closed and guarded by a
test that reproduces it deterministically.

## Remaining backlog
- **TurnController structural extraction** — the plan flags this as low remaining correctness value now
  that outcome findings #7/#8/#9 and the concurrency/mailbox gaps are closed; "extract only what each
  iteration touches." No forcing function remains; it's structural cleanup.
