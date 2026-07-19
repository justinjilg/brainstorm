# Iteration 007 — Result: doc-truth hierarchy (closed)

## Context
Codex's review flagged documentation drift as operational risk: in an agent-operated repo, wrong docs
cause wrong plans and duplicate implementation. Verified drift: 46 packages but docs said 44; the vision
doc listed `spawnSubagent()` wiring + trajectory capture as TODO though both ship. This iteration makes
factual claims match source and enforces it, and establishes the approved positioning.

## Shipped
- **Package count fixed at source-of-truth.** 44 → 46 in the README badge + two prose lines + CLAUDE.md.
  Added a **`docs-package-count` contract-check gate** that greps the docs for package-count claims and
  fails if any diverges from the actual `packages/*/package.json` count — proven to pass on truth and
  fail on drift (negative test). Codex's "generated facts from source" principle, enforced.
- **Stale vision-doc TODOs corrected.** `Trajectory capture in pipeline` and `Pipeline wired to real
  spawnSubagent() (currently placeholder)` were `[ ]` but Codex verified both ship
  (`trajectory-capture.ts`, `pipeline-dispatcher.ts`) — marked `[x]` DONE with file pointers; the
  placeholder note labeled historical.
- **KERNEL → proving-ground → destination positioning** added to the README's "What is Brainstorm"
  (the layered story the user approved): governed execution kernel is the asset; autonomous software
  engineering is the proving ground; AI-managed infrastructure ops is the destination.

## Gate
`contract-check` green (18 gates incl. the new one); the new gate has a negative test proving it catches
drift. No code paths touched (docs + a check script).

## Deliberately NOT done (scoped, low-value-to-rush)
- Full README/CLAUDE reconciliation of every count (tools "58+" vs "117 across ecosystem", "5 products")
  — these are cross-surface aggregates, not simple source facts; a doc-generation pass is the right tool,
  not hand-editing. The package-count gate is the template to extend.
- Labeling every historical assessment doc — the vision-doc TODO corrections addressed the load-bearing
  drift Codex named; a broad sweep is cooldown work for a later pass.

## Net
Docs no longer drift silently from source for the one fact that had a verified mismatch, and the gate
prevents recurrence. The positioning hierarchy is stated where a reader first meets the project.
