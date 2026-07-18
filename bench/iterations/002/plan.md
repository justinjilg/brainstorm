# Iteration 002 — measurement integrity + gpt-oss tool-calling crash

Seed: `ITER=002` → SEED = first 8 chars of `printf 002 | shasum`.

## Items
- **NEW-1 (direct, hot path)** — gpt-oss/vLLM tool-call streaming crash: `@ai-sdk/openai-compatible` throws
  `Expected 'id' to be a string` when the first delta for a tool-call index has a null id
  (vendor dist index.mjs:595). Fix: normalizing fetch wrapper on `createCustomProvider` that
  synthesizes an id for id-less first chunks of each tool-call index in the SSE stream.
  Evidence: gpt-oss reviewer seat crash in iteration 001 (bench/iterations/001/reviews/gpt-oss.out).
- **F (delegated → qwen3-coder)** — eval scorer env pollution: npm "Unknown env config" warnings
  pollute captured compiler output; pre-existing failure at scorer.test.ts ("reports compile failures").
- **G (delegated → qwen3-coder)** — eval runner repo-root resolution: walk up for pnpm-workspace.yaml
  instead of trusting cwd; loud error when absent (evidence: the invalidated first baseline run).

## Delegation protocol
brainstorm run --tools --lfg --max-steps 30, qwen3-coder, repo root; two failures → take over
directly and file the transcript as harness-gap evidence.

## Gate
- Unit/typecheck green on eval + providers/core.
- gpt-oss completes a 15-step tool-using session through brainstorm without the id crash.
- scorer.test.ts fully green (the pre-existing failure resolved).
- Stochastic review (new seeded panel) clean on verified P0/P1; ≥2/3 reviewers clean.
- Re-anchor: full code-correctness dim re-run after F lands (scorer change invalidates comparison).
