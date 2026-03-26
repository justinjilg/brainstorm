# @brainstorm/eval

Capability evaluation system — probes, runner, scorer, and scorecard.

## Key Exports

- `EvalRunner` — Execute capability probes against models
- `Scorer` — Score model responses against rubrics
- `Scorecard` — Aggregate eval results into a capability profile

## Purpose

Eval results feed into the `capability` routing strategy, enabling data-driven model selection based on measured performance rather than assumptions.

Results are stored as JSONL in `~/.brainstorm/evals/` and in the SQLite database.
