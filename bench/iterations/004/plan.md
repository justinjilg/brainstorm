# Iteration 004 — empty-output recovery + eval reliability

Seed: `ITER=004` → SEED = first 8 chars of `printf 004 | shasum`.

## Context
Three convergent failures this program, one root cause: a session that reaches its step cap (or a
reasoning model that emits reasoning-only turns) ends with EMPTY final output. Observed in:
- iteration-003 qwen3-coder reviewer seat (15 steps, no review)
- iteration-002/003 consensus-review workflow steps (empty artifacts)
- gpt-oss eval failures ("Used 10 steps, max allowed is 6", no output text)
The harness has all the pieces (empty detection now exists post-iter-003) but no RECOVERY.

## Items
- **R1 (lead, direct — hot path)** — force a final synthesis turn. When the agent loop exits because it
  hit maxSteps (not a natural stop) AND accumulated text is empty, run ONE more turn with tools
  disabled and a synthesis instruction ("You've done the work; now write your answer/result"), so the
  session produces output instead of nothing. Bounded to a single extra turn. Tests: step-cap-with-
  empty-output triggers exactly one tools-disabled synthesis turn; natural stop does not.
- **R2 (eval reliability)** — the capability eval cannot gate (100/90/50 on identical probes). Options
  to evaluate: (a) run each probe N times, score by majority/mean; (b) separate step-budget from
  correctness (a right answer in 10 steps when cap is 6 should not score 0); (c) score code-correctness
  by the sandbox artifact (does the file compile + pass), not by output-text substring match. Pick the
  cheapest that cuts variance; measure variance before/after on one dimension.
- **Process** — trim the review panel: Codex anchor (12/12) + ONE earned local seat (gpt-oss post-fix),
  drop the three-seat ceremony. Local seats that die empty should benefit from R1 anyway.

## Gate
- core/eval tests + typecheck green.
- R1 live proof: a capped gpt-oss session that previously ended empty now returns a synthesized answer.
- R2: measured variance reduction on the chosen dimension.
- Codex anchor review clean on verified P0/P1.
