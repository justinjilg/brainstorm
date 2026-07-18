# Iteration 005 — Progress (in flight)

Session-scope mutable runtime state by lifecycle. Open iteration; units land incrementally.

## Done (committed, tested, green)
- **005.1 — Task store** (Codex's #1 highest-risk global). New `session-context.ts` (AsyncLocalStorage,
  mirrors workspace-context) gives the current sessionId during tool execution; the loop enters it
  alongside `enterWorkspace`. `task-manage.ts` module-global `tasks`/`nextId`/`onTaskEvent` → per-session
  stores keyed by `getSessionId()`, 256-session LRU bound, `clearTasks(sessionId)` cleanup. 3
  concurrent-isolation tests.
- **005.2 — Transaction state + checkpoint managers.** `transaction.ts` `transactionActive`/
  `transactionFiles` → per-session; `checkpoint.ts` `activeCheckpoint` singleton → per-session Map
  (a second run's init no longer overwrites the first's manager, so rollbacks revert the right
  session's files). 3 concurrent-transaction tests.

Both green: core 625 + the new tool tests; as-any 295/295; contract-check green. (Docker sandbox
integration tests fail on Docker Desktop org sign-in — environmental, unrelated.)

- **005.3 — Shell background + tool-output handlers.** DONE. Module-global handlers cross-wired
  concurrent runs' shell output; now per-session, with each background job tagged by its originating
  session so completion events route back to it (the job outlives its turn). 2 isolation tests.
- **005.4 — Learned routing → injectable `RoutingLearningState`.** DONE. Process-scoped (flywheel kept);
  the 5 state containers sit behind live `let` bindings + a setter, so swapping state is atomic with
  zero logic change — isolation + testability, no call-site ripple. 1 isolation test.

## Remaining
- **005.5 — Eval reliability** (separate work, not session-scoping): artifact-correctness scoring
  (compile/test the sandbox result, not output-substring); correctness vs efficiency separated; 3-trial
  noisy subset; paired same-seed comparisons — so the capability eval can gate again.

## Status
All FOUR correctness-critical concurrency globals Codex flagged are now session/process-scoped (task,
transaction, checkpoint, shell handlers, learned routing). Six isolation tests. Every unit self-contained
and green (core 625 / router 118 / new tool tests; as-any 295/295). The routing injection used a live-
`let`-binding swap rather than threading an instance through ~7 call sites — the plan's isolation goal
with minimal ripple. 005.5 (eval reliability) is the remaining, independent piece.
