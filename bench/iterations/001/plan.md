# Iteration 001 — model metadata + output tokens

Seed: `ITER=001` → SEED=`$(printf 001 | shasum | cut -c1-8)` = computed at review stage.

## Hypothesis
The dominant harness-side cap on local-model coding capability is wrong model metadata:
every custom-endpoint model gets contextWindow 8192 / maxOutputTokens 4096 / reasoning:false,
and the agent loop never passes an output-token budget to streamText. Fixing A–D should lift
multi-step and tool-sequencing scores (currently the weakest dimensions for all three models)
and eliminate gpt-oss-120b's empty-response fallback retries.

## Items
- **A** — discovery heuristics + honor `context_length`/`max_model_len` from /v1/models (packages/providers/src/local/openai-compat.ts)
- **B** — `[[models]]` overrides for contextWindow/maxOutputTokens/reasoning (packages/config schema + registry apply)
- **C** — pass routed model's maxOutputTokens into streamText (packages/core/src/agent/loop.ts)
- **D** — compaction correctness test with a realistic window

## Gate
- Unit/typecheck green on providers, config, core.
- Smoke probes green (registry metadata correct; multi-step coding session with no compaction; gpt-oss long generation without empty-length retry).
- Stochastic review: verified P0/P1 all resolved; ≥2 of 3 reviewers clean on re-review.
- Tool-sequencing + multi-step `--capability` eval dims on q3-next and q3-coder ≥ baseline.
