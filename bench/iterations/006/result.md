# Iteration 006 — Result: two-level outcome round-2 close-out (Codex #8/#9)

## Context
Iteration 004 landed the two-level outcome contract (aggregate `RunOutcome` over per-model
`ModelAttemptOutcome`s) with forced synthesis recorded as its own attempt. Codex's first review of that
work opened findings #8 (synthesis attempt accounting) and #9 (recovery-sequence ordering). Round-1 fixes
recorded synthesis as a distinct `synthAttempt` and built an ordered `recovery` array. This iteration is
the round-2 close-out after Codex re-reviewed those fixes.

## Codex round-2 verdict (`reviews/codex-r2.out`)
- **#9 resolved.** Both the nudge and verify recursions append this turn's `forced_synthesis` before
  `tool_nudge` / `verification_retry`, preserving recovery order without duplication.
- **#8 still open** — two concrete defects, both real on inspection:
  1. **Per-attempt cost double-count (P1).** `thisAttempt.costUsd` was `turnCost`, the session-cost
     delta measured *after* forced synthesis had already booked its own delta. `synthAttempt.costUsd`
     records that same synthesis delta separately → the synthesis turn was charged twice.
  2. **`synthAttempt` dropped on recursion.** The nudge/verify recursions carried `thisAttempt` into
     `_attemptsSoFar` but omitted `synthAttempt`, so a synthesize-then-verify/nudge chain lost the
     synthesis invocation from the terminal `RunOutcome.attempts` even though `_recoverySoFar` still
     listed `forced_synthesis`.

## Shipped (fixes)
- `thisAttempt.costUsd = turnCost - synthAttempt.costUsd`. Per-attempt costs now sum exactly to the
  aggregate `outcome.costUsd`. `recordOutcome` (Thompson routing) keeps `turnCost` intentionally — it's a
  single call attributing the whole turn's cost to the same model, not a double-count.
- Both recursion sites append `synthAttempt` alongside `thisAttempt` in `_attemptsSoFar`, matching the
  terminal aggregate.

## Gate
- New regression test `does not double-count synthesis cost across attempts` (non-zero pricing) asserts
  `attempts[0].costUsd < aggregate` and `sum(attempts) == aggregate` — both fail against the pre-fix code.
- core 628 green (+1); `as-any` 295/295; core typecheck clean.

## Net
The two-level outcome now accounts cost correctly at both levels and never loses a model invocation from
the attempts chain across recovery recursions. #8 and #9 closed; the contract is internally consistent
(∑ attempt cost = run cost) and complete (every model call, including synthesis, appears in `attempts`).
