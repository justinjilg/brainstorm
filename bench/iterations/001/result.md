# Iteration 001 — Result: GREEN (committed)

## Items shipped
- **A** — Discovery heuristics for custom-endpoint models (family table + server `context_length`/`max_model_len`; embedding models excluded from chat registry; <7B checkpoints capped at 32k; warn on 8192 default).
- **B** — `[[models]]` overrides extended with `contextWindow`/`maxOutputTokens`/`reasoning`; applied via `applyModelOverrides()` at construction AND refresh(); `!== undefined` semantics.
- **C** — `computeOutputBudget()`: routed model's output budget forwarded to streamText, clamped to remaining context (measured messages + measured system prompt + tool-schema allowance; exact-remainder behavior near exhaustion).
- **D** — Compaction correctness tests for realistic windows.

## Review (seed e193a01e)
- **Codex (anchor, correctness)**: 4/4 findings verified real → all fixed with dedicated tests. Round-2 raised 2 refinements + 1 new P1 (floor overflow) → all fixed with tests. Final round: first attempt hung on stdin (codex exec background quirk — lesson: `< /dev/null`); re-run in flight at close; every finding covered by unit tests (70 providers + 607 core green).
- **qwen3-coder (security, via brainstorm)**: completed through the harness (dogfood pass); 4 findings, 0 survived verification (P1 misread a conservative clamp). Precision 0/4.
- **gpt-oss (architecture, via brainstorm)**: seat crashed — `Expected 'id' to be a string` in @ai-sdk/openai-compatible tool-call streaming. Filed as iteration-002 item NEW-1.
- Reviewer precision: codex 4/4; qwen3-coder 0/4; gpt-oss n/a (crash).

## Gate
- Tests: providers 70 ✓, config 56 ✓, core 607 ✓.
- Live smokes: registry metadata correct for all 8 models ✓; gpt-oss 170-line generation with no empty-length retry ✓.
- Eval dims vs baseline: q3-next tool-seq 36% (=; one-probe dip proved flake by re-run), q3-next multi-step 36% (=), q3-coder tool-seq 27% (=), q3-coder multi-step **21% (+7pts)**.

## Evidence for backlog
- gpt-oss tool-call id crash (NEW-1, iteration 002).
- Failed tool-seq probes are dominated by "used glob instead of grep" and step-cap overruns — candidate: tool-selection guidance in system prompt or probe leniency review (iteration 3+).
- codex exec background runs must close stdin.
