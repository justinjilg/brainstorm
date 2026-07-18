# Iteration 005 — Session-scope mutable state (by lifecycle)

Seed: `ITER=005` → SEED = first 8 chars of `printf 005 | shasum`.

## Context
Codex's session-isolation audit (verified) found ~20 module-global mutable state holders that concurrent
runs (server / Slack / desktop / subagents) corrupt — colliding IDs, cross-wired event handlers, shared
transaction flags, one run's routing failures quarantining another's models. This iteration scopes them
by explicit **lifecycle**, not one blanket mechanism (an ALS per-run store is insufficient — a
background job can outlive its turn).

## Four lifecycle scopes
- **turn-scoped**: transient stream handlers, per-attempt buffers (already local to the loop turn).
- **session-scoped**: task store, transaction state, checkpoint manager — explicit `Map<sessionId,…>`
  with cleanup + a cardinality bound (missed cleanup must not leak).
- **background-job-scoped**: shell background commands that outlive a turn — explicit job-id maps.
- **process-scoped**: provider health, learned routing — legitimately cross-session; move OUT of module
  globals into an injected instance for isolation + testability, keeping the flywheel.

## Session context (new, mirrors workspace-context)
`packages/tools/src/session-context.ts` — AsyncLocalStorage giving the current `sessionId` during tool
execution (`withSession`/`enterSession`/`getSessionId`, default `"__default__"` for standalone use).
The loop enters it alongside `enterWorkspace`. Session-scoped stores key off `getSessionId()`; explicit
cleanup + LRU cap (mirrors the iter-003 quarantine bound) so a missed cleanup can't grow unbounded.

## Units (each shippable, review-gated)
- **005.1 (this branch first)** — Task store (Codex #1 highest-risk): convert `tasks`/`nextId`/
  `onTaskEvent` in `packages/tools/src/builtin/task-manage.ts` to per-session stores keyed by
  `getSessionId()`; per-session event handlers; `clearTasks(sessionId)` cleanup + cap. Regression test:
  two concurrent sessions don't collide on IDs / see each other's tasks / cross-wire handlers.
- **005.2** — Transaction state (`transaction.ts` `transactionActive`/`transactionFiles`) + checkpoint
  manager (`checkpoint.ts` `activeCheckpoint`) → session-scoped.
- **005.3** — Shell background registry + sandbox config (`shell.ts:258`, `shell.ts:150`:
  currentSandboxLevel/currentProjectPath/active Docker sandbox — safety-critical) → background-job /
  session scoping.
- **005.4** — Learned routing (`learned.ts` modelStats/recentOutcomes/quarantinedUntil/auditLog) →
  injected `RoutingLearningState` owned by a router/process instance (NOT session-scoped — the
  cross-session flywheel is intentional; this gives isolation + testability).
- **005.5 (parallel work item) — eval reliability**: artifact-correctness scoring (compile/test the
  sandbox result, not output-substring); correctness vs efficiency separated; 3-trial only for the noisy
  subset; paired same-seed comparisons. Then the eval can gate again.

## Gate (per unit)
changed-package tests + typecheck + as-any 295/295 + contract-check green; a concurrent-sessions
regression test per scoped global; Codex anchor review, verified P0/P1 closed. Commit on
`iter/005-session-scope`.
