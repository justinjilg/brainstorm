# Iteration 011 — Result: frozen end-to-end truth contract

Brainstorm now has a stable definition of “above 9” that cannot be satisfied by
model prose, blended correctness/efficiency scores, or an easier edited prompt.

## Delivered

- Tracked root `AGENTS.md` shared across Claude, Codex, Brainstorm, and other
  harnesses.
- `kernel-e2e-v1`: 30 immutable sandbox tasks (10 coding, 8 web,
  5 documentation, 4 infrastructure, 3 adversarial).
- Strict dataset loader with traversal, duplicate-id, unknown-rubric, and
  verifier-contract validation.
- Five independent score axes, Wilson intervals, verified completion, usable
  terminal, recovery, silent failure, and state corruption metrics.
- Contract gate with a SHA-256 fingerprint and a negative mutation fixture.
- Public scoring/trial protocol in `docs/e2e-score-contract.md`.

## Evidence

- Eval: 12 files, 89 tests passed.
- Eval TypeScript: clean.
- Contract meta-tests: 27 passed, including the frozen-suite mutation proof.
- Contract preflight: 19/19 green.

## Next forcing function

The CLI currently hides the structured `RunOutcome` in JSON mode and makes
requested-model versus fallback-model behavior difficult to audit. Iteration 012
will make outcome truth and model pin semantics operator-visible.
