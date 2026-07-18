# Iteration 002 — Result: GREEN (committed)

## Items shipped
- **NEW-1** — gpt-oss/vLLM tool-call streaming fixed: `createToolCallIdNormalizingFetch` SSE transform.
  Root-caused with a captured raw stream: vLLM bumps the tool-call `index` per argument fragment, so the
  SDK saw phantom new calls with no id/name and killed the session. Normalizer routes fragments by
  seen-server-index (valid interleaved parallel streams preserved), falls back to the open call only for
  unseen quirk indices, synthesizes ids, caps line buffering at 4MiB (fail-open pass-through). 6 tests.
- **F (delegated, qwen3-coder)** — npm-warn stripping in eval TypeScript verifier; pre-existing scorer
  test failure resolved. Agent located the true source file (verifiers/typescript.ts) despite the prompt
  pointing at scorer.ts.
- **G (delegated, qwen3-coder)** — `resolveRepoRoot()` walk-up for introspection probes + tests; then
  hardened per Codex: sandbox probes skip resolution, explicit projectDir honored as-is, error text fixed.

## Review (seed 6fc978af)
- **Codex (anchor, architecture)**: 3 P1s, 3/3 verified real → all fixed with tests; R2 clean. Running precision 7/7.
- **consensus-review workflow (dogfood)**: ran end-to-end incl. gpt-oss security step with tools (streaming fix held).
  gpt-oss produced 7 structured findings; 1 verified (SSE buffer DoS — converged with Codex) → fixed.
  HARNESS FINDING: quality/style steps emitted empty artifacts yet workflow reported complete (conf 0.60)
  → iteration-003 item: workflow step artifact validation.
- **qwen3-next (security)**: 2 findings, 0 gating (1 rebutted vs SDK source, 1 pre-existing pattern).

## Gate + falsification test
- Tests: providers 77 ✓, eval 73 ✓, builds/typecheck ✓.
- Live: gpt-oss multi-step tool session (read→write→verify→summary) with zero crashes ✓.
- **Falsification** (gpt-oss full eval vs 28% crash-era baseline): crash-floored dims jumped —
  tool-selection 10%→40%, multi-step 7%→21%, instruction-adherence 50%→80%. Overall flat (29%)
  because code-correctness fell 40%→10%: ALL failures are step-cap overruns ("Used 9-10 steps, max 6")
  plus output-text checks — the newly-agentic model writes code to files and verifies, which the probes
  penalize. Eval-design finding, not a capability regression → iteration-003 item (score sandbox
  artifacts, keep caps principled; do NOT tune probes to the model).
- Re-anchor after scorer fix: q3-next code-correctness 90%, q3-coder 80% (new anchors).

## Backlog feed (iteration 003+)
1. Probe design: artifact-based scoring for code-correctness; step budgets vs tool-using reasoning models.
2. Workflow preset artifact validation (empty-output steps must fail the step).
3. E — quality-signals corrective feedback injection. H — learned-routing quarantine.
4. npx/PATH hardening in eval verifier (qwen3-next P2, pre-existing).
