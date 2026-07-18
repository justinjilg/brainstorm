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

## Remaining (each its own focused pass — larger ripple, deliberately not rushed)
- **005.3 — Shell background registry + sandbox config** (`shell.ts:258`, `:150` currentSandboxLevel/
  currentProjectPath/active Docker sandbox — safety-critical). Background-job lifecycle: jobs outlive
  their turn, so explicit job-id maps + cleanup, not just the session ALS.
- **005.4 — Learned routing → injected `RoutingLearningState`.** Process-scoped (the cross-session
  flywheel is intentional); move `learned.ts` modelStats/recentOutcomes/quarantinedUntil/auditLog out
  of module globals into an instance owned by the router. Ripples across ~7 call sites at the core↔router
  boundary + the exported routing API — an API-changing refactor best done as its own reviewed pass.
- **005.5 — Eval reliability.** Artifact-correctness scoring (compile/test the sandbox result, not
  output-substring); correctness vs efficiency separated; 3-trial noisy subset; paired same-seed
  comparisons — so the capability eval can gate again.

## Note
The two landed units are self-contained in `packages/tools` (clean seams). 005.3/005.4 cross package
boundaries and change public APIs; per the iteration-004 lesson (rushing a large kernel refactor cost
three adversarial-review rounds), each gets its own focused, review-gated pass rather than a hurried one.
