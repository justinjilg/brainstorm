# Iteration 003 — Result: GREEN (committed)

## Items shipped
- **E (direct)** — quality-signals middleware now INJECTS a one-shot corrective hint into the
  triggering tool result on Read:Edit ratio degradation (was log-only; the docstring lied). Serializes
  defensively; one-shot consumed only after the result is built.
- **H (direct)** — learned-routing quarantine: rolling 10-outcome per-model window across task types;
  >80% failures → 30-min exclusion from Thompson selection; never empties the candidate set; both
  tracking maps LRU-bounded at 200 with expiry sweep.
- **W (delegated → qwen3-coder)** — workflow step artifact validation: empty/whitespace-only step
  output fails the step. Caught its own consensus-review empty artifact LIVE on first run.
- **+4 Codex-found fixes** — most important: the agent loop was DISCARDING every `afterToolResult`
  middleware return (loop.ts), which silently disabled the secret-substitution fail-closed redaction
  in production. Also: whitespace-only turns now classified empty before success recording; workflow
  failures attributed to the concrete routed model not "auto".

## Review (seed 221407c0)
- **Codex (anchor)**: 5 findings, 5/5 verified real → all fixed (3 rounds); 1 final P2 rebutted on
  semantics (quarantine expiry is absolute → FIFO eviction is correct). Running precision 12/12.
- **qwen3-coder seat**: exhausted 15 steps, ended with EMPTY output — no review delivered.
- **consensus-workflow seat**: FAILED BY DESIGN — its gpt-oss step emitted an empty artifact and W's
  new validation failed the workflow loudly (iteration-002 would have reported success). Dogfood win.
- Both dead seats + the gpt-oss eval failures share one root cause → iteration-004 lead item.

## Milestone measurements (full 75-probe eval ×3)
| model | overall | vs baseline | notable |
|---|---|---|---|
| gpt-oss-120b | 35% | **+7 (was 28%)** | tool-selection 10→50, multi-step 7→29 — streaming fix landing |
| qwen3-next-80b | 43% | −9 (was 52%) | code-correctness 50% this run vs 100%/90% prior — see variance |
| qwen3-coder-next | 35% | +2 (was 33%) | code-correctness 70%, steady |

**SWE-bench: not attempted (Docker daemon down). No heuristic result reported.**

## HONEST READ — is this progress or theatre?

**The capability eval cannot detect what we fixed, and here's the proof:** q3-next code-correctness —
the SAME 10 probes, no code change between runs — measured **100% → 90% → 50%** across three eval runs
this session. A 50-point swing on identical inputs means the metric's run-to-run noise is larger than
any improvement we could make in one iteration. The flat/noisy overall numbers are therefore NOT
evidence of no progress; they're evidence the instrument can't measure it. Gating on this eval was a
mistake in the original plan.

**The real evidence the fixes work is elsewhere, and it is strong:**
1. **Falsification test passed.** gpt-oss's tool-dependent dimensions were FLOORED at 10%/7% while its
   tool-calling crashed. After the iteration-002 streaming fix they jumped to 50%/29% — a specific,
   predicted, attributable gain. That is not noise.
2. **Six real bugs found and fixed by dogfooding**, each one a thing that would break a real user:
   files written to $HOME, eval probes mutating the live repo, gpt-oss unable to use tools at all, the
   discarded-middleware-return security hole, workflows reporting success on empty output, config
   overrides lost on refresh. None were manufactured; every one reproduced.
3. **The loop is self-correcting.** W caught its own review workflow's empty artifact; the LRU bug I
   introduced fixing a P2 was caught by existing tests before commit.

**Where the theatre risk is real:** the local reviewer seats are near-zero precision (qwen 0/N verified;
Codex carries 12/12). The three-seat seeded panel is mostly ceremony — iteration 004 trims it to
Codex-anchor + one earned local seat. And gating on the capability eval stops now; it becomes a thing
to FIX (iteration 004), not a thing to pass.

**Verdict: real progress, over-instrumented.** The harness is meaningfully more capable with local
models than 3 iterations ago (gpt-oss went from crash-on-tools to a working agentic reviewer). The
measurement apparatus around it was heavier than it needed to be and partly pointed at a noisy metric.
