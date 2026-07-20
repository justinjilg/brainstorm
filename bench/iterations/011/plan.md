# Iteration 011 — Evaluation truth contract

## Goal

Create the immutable measurement layer required to move every product score
above 9 without optimizing against subjective impressions.

## Scope

- Add a committed cross-harness `AGENTS.md` with the product hierarchy and
  kernel safety rules.
- Freeze a 30-task, five-domain end-to-end suite with sandbox-only fixtures.
- Define independent correctness, quality, efficiency, resilience, and
  governance result axes.
- Add a reviewable scorecard with confidence intervals and explicit
  silent-failure/state-corruption rates.
- Release-gate the suite fingerprint, schema, paths, and domain distribution.

## Gate

- `@brainst0rm/eval` tests and typecheck green.
- Contract gate proves committed state passes and an in-place suite mutation
  fails.
- Full contract preflight green.
