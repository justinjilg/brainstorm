# Iteration 004 — Two-level outcome contract + forced synthesis (FOUNDATION)

Seed: `ITER=004` → SEED = first 8 chars of `printf 004 | shasum`.
Supersedes the earlier narrow 004 plan (forced-synthesis-only), per the approved consolidation arc and
two rounds of Codex design review.

## The contract
> One aggregate **RunOutcome**, composed of one or more **ModelAttemptOutcome**s, with explicit
> termination, recovery, artifacts, checks, and cost.

Two levels because a logical run can span multiple model attempts (fallback: A fails empty → B
succeeds). Thompson/quarantine need per-attempt evidence; surfaces need one aggregate. A flat outcome
would erase A's failure.

## 004.0 Preflight (get to green first) — DONE
- Memory property test isolated to a temp `$HOME` (was flaking on real `~/.brainstorm`; +20s backstop).
- `as any` 298 → 295 by fixing the 3 net-new casts properly (tolerant `contentCharLength` in
  `computeOutputBudget`; removed the `FetchFunction` cast).
- Regenerated the two stale BR contract artifacts. `contract-check` green.

## 004.1 Types (`packages/shared/src/types.ts`)
`StopCause` (natural_stop|step_cap_reached|empty_output|truncated_tool_call|output_limit|
content_filtered|error|budget_exhausted|fallback_exhausted|aborted), `CheckStatus`
(passed|failed|not_run|unknown), `ModelAttemptOutcome`, `RunOutcome` (attempts[], initialStopCause,
recovery, hasFinalResponse, producedArtifacts?, madeChanges?, tri-state verification/security/judge,
costUsd). Security note: blocking a dangerous action = control succeeded while execution failed → tri-
state, distinct from run status.

## 004.2 loop.ts — per-attempt vs aggregate + step-cap detection
Record each attempt as `ModelAttemptOutcome` → Thompson/quarantine (the fallback record at `:1400`
becomes attempt N). Delete unconditional `router.recordSuccess?.()` at `:1518`; momentum records only
the successful final attempt WITH task type. Increment `stepsCompleted` in `onStepFinish`; classify
`step_cap_reached` only when max reached AND last step still requested continuation (reuse the
length/content-filter split at `subagent.ts:393`).

## 004.3 invokeModelAttempt seam + forced synthesis
Extract `invokeModelAttempt()` (first strangler seam) sharing provider normalization, output budgeting,
abort, watchdog, cost, trajectory — used by normal AND synthesis attempts (no duplicated streamText
block). Forced synthesis triggers on `step_cap_reached && !hasFinalResponse` (NOT producedArtifacts).
One tools-disabled turn; record `initialStopCause:step_cap_reached`, `status:succeeded`,
`recovery:forced_synthesis`.

## 004.4 Emit outcome + fix pipeline
`AgentEvent.done` gains `outcome: RunOutcome` additively (keep old fields). `orchestration-pipeline.ts`:
exactly one terminal event + one finalization (completed|failed|paused|aborted); fix budget-pause
double-finalize (`:246`+`:406`); emit `failed` on any phase `success===false`; validate empty
standard-phase outputs. Update `trajectory-capture.ts:187` terminal switch for all four types.

## Gate
core/shared/router/workflow tests + typecheck green; outcome-contract + pipeline regression tests;
preflight baseline green (contract-check, memory test). Live: a step-capped gpt-oss session that
previously ended empty returns a synthesized answer with `recovery:forced_synthesis`. Codex anchor +
one advisory local seat; verified P0/P1 closed. Commit on `iter/004-outcome-contract`.
