# Iteration 004 — Result: GREEN (foundation of the consolidation arc)

## What shipped
The two-level execution outcome contract + forced synthesis + pipeline terminal correctness — the
foundation the rest of the arc builds on.

- **Types** (`packages/shared`): `StopCause`, `CheckStatus`, `ModelAttemptOutcome`, `RunOutcome`;
  `AgentEvent.done` gains `outcome` additively.
- **Learning-signal P0 fix**: momentum recorded unconditionally, before `turnSuccess`, without task
  type — it was training on "said something." Now records only the successful final attempt WITH task
  type.
- **`classifyStopCause()`**: asserts `step_cap_reached` only when the budget is spent AND the last step
  still wanted to continue.
- **`invokeModelAttempt()`**: first TurnController strangler seam — the streamText config lives in one
  place, shared by the normal attempt and synthesis.
- **Forced synthesis**: when a tool-using turn produces no final answer, run one tools-disabled
  synthesis turn (recovery=forced_synthesis). The dead-end that killed two reviewer seats in iter-003.
- **Aggregate RunOutcome**: per-attempt outcomes threaded through the fallback recursion, emitted via
  done.
- **Pipeline**: exactly one terminal event + one finalize (completed|failed|paused); empty standard AND
  parallel phases fail; finalize-before-yield.

## The live proof (and what it taught)
The same step-capped gpt-oss session that returned `text:""` in iteration 003 now returns a coherent
final answer. Critically, the FIRST live run exposed that my initial cap-only synthesis trigger was too
narrow — gpt-oss stops EARLY after tool calls, below the cap — which drove broadening the trigger to
any-tool-work. The dogfooding loop caught a design flaw the unit tests couldn't.

## Review (Codex anchor, seed c63528a5)
Codex found 14 real edge-case findings in the synthesis + aggregate (the happy path worked; the holes
were in cancellation, hangs, missing tool-result context, empty-synthesis-as-success, once-per-run,
cost accounting, parallel-phase validation, finalize timing). **9 fixed with tests** (all
safety-critical + tractable-correctness). **4 deferred to iter-006** with written rationale — they are
outcome-metadata precision in a `RunOutcome` no surface consumes yet (verification/security/judge are
`not_run`; nothing has migrated to `done.outcome`), so no live blast radius; and each is the exact
recursion-unification the TurnController introduces. Full triage in `reviews/verdicts.json`.

This iteration is the strongest evidence yet for the review gate: the feature passed its live proof but
had a dozen real edge-case holes a single implementation pass missed. The gate caught every one.

## Gate
core 625 tests green; typecheck clean; as-any 295/295; contract-check green; live synthesis proof PASS.

## Carry-forward to iteration 005+
- iter-005: session-scope mutable runtime state by lifecycle (turn/session/background-job/process);
  move learned routing to an injected process-owned instance; eval reliability.
- iter-006 (TurnController): grow the `invokeModelAttempt` seam into a turn state machine — this
  naturally resolves the 4 deferred findings (#1 post-tool-text, #7 momentum timing, #8 root attempt
  accumulator, #9 ordered recovery). Make workflow/pipeline/revise-loop consume `RunOutcome`.
