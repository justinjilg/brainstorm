# Iteration 010 — Result: buildRunOutcome() seam + Consolidation Arc CLOSED

## This iteration
The only remaining backlog item was the TurnController structural extraction — flagged low-value with
no forcing function. Rather than a big-bang refactor of the ~2000-line `runAgentLoop`, I took the single
highest-value bounded strangler seam and stopped.

**Extracted `buildRunOutcome()`** (`packages/core/src/agent/loop-outcome.ts`) from the inline
aggregate-outcome block (`loop.ts:2207-2237`). That block was the exact site of Codex **#8** (attempts
ordering + synthesis cost/attempt double-count) and **#9** (recovery-sequence composition) — bug-prone
logic that is a *pure data transformation*: given the attempts, recovery actions, and a pre-computed
cost delta, it deterministically yields a `RunOutcome`. It moved out with **zero behavior change**; the
loop keeps the side effects (momentum recording, `done` emission) and calls the helper.

- **Value:** the #8/#9-class logic is now directly unit-testable in milliseconds (10 characterization
  tests) instead of only through the full mocked loop harness.
- **Behavior-preservation evidence:** the existing forced-synthesis + background-delivery loop tests —
  which assert attempts/recovery/cost *through* the loop — pass unchanged.
- core 639 (+10); typecheck clean; `as-any` 295/295.

**Why stop here:** beyond this one seam, no further high-value *safe* extraction exists without a
forcing function. Continuing to carve the loop would be larger, riskier churn in the critical path — the
opposite of the arc's discipline ("strangler not big-bang; extract only what each iteration touches").

## Consolidation Arc — closed findings (004 → 010)
Every verified correctness finding raised across the arc (dogfood falsification, two rounds of Codex
anchor review, and the concurrency/mailbox audits) is closed:

| # | Finding | Iteration |
|---|---|---|
| Two-level outcome contract (`RunOutcome` ← `ModelAttemptOutcome`) + forced synthesis as an explicit terminal | 004 |
| Broken learning signal (`recordSuccess` fired unconditionally, pre-`turnSuccess`, no task type) | 004 |
| Pipeline double-finalize / missing terminal types | 004 |
| Session-scoping of ALL mutable module globals (tasks, tx, checkpoint, scratchpad, process-manage, shell handlers, file-tracker, tool-health) + injectable routing state | 005 |
| Transaction rollback file-hash safety (record-time TOCTOU + null-hash bypass) | 005.6 |
| Subagent session scoping; tx cleanup | 005.6 |
| Doc truth: package-count 44→46 + enforcing contract gate; stale vision TODOs; KERNEL→proving-ground→destination positioning | 007 |
| Codex #7 momentum recorded only at true terminal | 006 |
| Codex #8 per-attempt cost double-count + synthAttempt lost on recursion | 006 |
| Codex #9 recovery as an ordered sequence (fallback→synthesis no longer erased) | 006 |
| Coordinator relaxed from global serialization to per-conversation concurrency; every `runAgentLoop` caller session-scoped; `enterSession`-in-`withSession` proven safe under concurrency | 008 |
| Turn-tail background-completion loss (Scenario B, during forced synthesis) → mailbox requeue | 009 |
| First TurnController seam: pure, unit-tested `buildRunOutcome()` | 010 |

## State of the kernel
The governed execution kernel now has: a trustworthy two-level outcome contract with a correct learning
signal; forced synthesis as an explicit, live-proven recovery terminal; single-terminal pipeline
semantics; full cross-session isolation of mutable state with safe concurrent conversations; no silent
loss of background completions; enforced documentation truth; and its most bug-prone aggregation logic
extracted behind a pure, tested seam. Open P0/P1: **0**.

## Not done (deliberately, no forcing function)
- Full TurnController extraction beyond the outcome seam — structural cleanup with no correctness driver;
  the right approach remains strangler-per-touch, not a scheduled big-bang.
- Wiring live verification/security/judge results into `RunOutcome` (left `not_run`) — a genuine
  follow-on when those gates run inline, not a current gap.

**The consolidation arc is complete.** Autonomous iteration ends here; further work should be
user-directed against a fresh goal.
