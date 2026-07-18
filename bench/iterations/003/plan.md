# Iteration 003 — behavior quality + workflow integrity

Seed: `ITER=003` → SEED = first 8 chars of `printf 003 | shasum`.

## Items
- **E (direct)** — quality-signals middleware now injects a one-shot corrective hint into the
  triggering tool result when the Read:Edit ratio degrades (was log-only; docstring claimed
  injection that didn't exist). 3 tests.
- **H (direct)** — learned-routing quarantine: rolling 10-outcome per-model window across task
  types; >80% failures → 30-min exclusion from Thompson selection; never empties the candidate
  set; cooldown expiry clears the window. 4 tests.
- **W (delegated → qwen3-coder)** — workflow step artifact validation: consensus-review's
  quality/style steps emitted empty artifacts yet the workflow reported complete (conf 0.60).
  Empty/whitespace artifacts must fail the step.

## Gate (milestone iteration)
- Unit/typecheck green on core, router, workflow.
- Stochastic review (seed 003): codex anchor + drawn seats; verified P0/P1 resolved.
- MILESTONE measurements: full 75-probe eval ×3 models against re-anchored baselines;
  SWE-bench single-instance Docker validation attempt (x86 emulation) — heuristic mode never
  counts as a pass.
