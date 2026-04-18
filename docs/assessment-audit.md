# v11 Calibration & Bias Audit — 2026-04-18

Auditor of the methodology-rerun synthesis (v10 → v11, zero code changes since commit `01e8295`).

## Job 1 — Arithmetic

All 10 per-dimension sums and the overall mean reproduce exactly to 3 decimal places. Spot-check:

- Overall: 58.98 / 10 = 5.898 → 5.90 ✓
- Code 7.533 · Wiring 6.860 · Test 6.600 · Prod 4.765 · Ops 5.717 · Sec 6.425 · Doc 5.623 · Fail 6.550 · Scale 3.936 · Ship 4.834 ✓
- σ on the 10 agent overalls: population 0.0469, sample 0.0494. Synthesis reports **0.047** — that is the population σ, consistent with v10's reporting convention. No error.

**Result: arithmetic verified.**

## Job 2 — Methodology-Test Finding Audit

All five "new v11 findings" were sourced directly from current repo state. Each verified against checked-in code:

1. **CI ratchet not wired — VERIFIED.** `ls .github/workflows/` returns `ai-review.yml, ci.yml, codeql.yml, e2e.yml, npm-publish.yml, release.yml`. Grep of `check-as-any-budget` across all six YAMLs returns **zero matches**. The script at `scripts/check-as-any-budget.mjs` is never invoked by CI. Governance claim is aspirational.

2. **`continue-on-error: true` on test jobs — VERIFIED.** Three instances in `.github/workflows/ci.yml`:
   - Line 38 — tool-catalog drift check
   - Line 53 — core test suite
   - Line 59 — vault test suite
     Two of those three are the actual test steps. Green CI does not prove tests pass.

3. **OP_SESSION scrub bypass — VERIFIED.** `packages/tools/src/builtin/shell.ts:35-60` defines `SCRUBBED_ENV_NAMES` containing literal `"OP_SESSION"` (line 38). `SCRUBBED_ENV_NAMES.has("OP_SESSION_myaccount")` is **false** — `Set.has` is exact-match, not prefix. The regex `/(?:API_KEY|SECRET|PASSWORD|CREDENTIALS|PRIVATE_KEY|_TOKEN)/i` does **not** match `OP_SESSION_myaccount` (no matching substring). Under "restricted" default, a real 1Password session token leaks to every shell child. High-severity.

4. **Restricted sandbox allows sensitive file reads — VERIFIED.** `packages/tools/src/builtin/sandbox.ts` `checkSandbox` delegates to `checkRestricted`, which iterates `BLOCKED_PATTERNS` (lines 18-104). The list covers rm/mkfs/sudo/curl-pipe-sh/base64-pipe/python-dash-e/git-filter-branch etc. **No entry** blocks `cat`, `~/.ssh/*`, `~/.aws/*`, `~/.netrc`, or `~/.config/op/*`. `cat ~/.ssh/id_rsa` passes. Design gap is real.

5. **No busy_timeout pragma — VERIFIED.** `grep -rn busy_timeout packages/db/src/` returns zero matches. `packages/db/src/client.ts:31-36` sets `journal_mode=WAL`, `foreign_keys=ON`, `optimize` — but no busy_timeout. Concurrent writers (desktop + CLI opening `~/.brainstorm/brainstorm.db`) will fail immediately with `SQLITE_BUSY` instead of retrying.

**All 5 findings: VERIFIED. None hallucinated.**

## Job 3 — Bias Audit of Synthesis

Pragmatist's "8 modified tracked files" claim. `git status --short | grep "^ M"` returns a single line: `docs/assessment-synthesis.md` (the synthesis file itself). That's 1 file, not 8, and it's the synthesis's own workspace artifact — irrelevant to the code-change claim. **Synthesis is correct to flag the Pragmatist as stale/hallucinated.**

Omission/softening check: none found. The synthesis flags the Pragmatist, gives the Operator the largest downward revision (−0.19), and explicitly withdraws credit on Security Posture (−0.26) where v10 gave A2-closure credit that v11's Attacker invalidated. Precision is not overclaimed — the calibration section explicitly says reporting beyond 0.1 is false signal. Action list is appropriately prioritized by severity (OP_SESSION first). No glossed weaknesses, no self-congratulatory language.

One minor note: "8/10 agents scored flat or lower" in the delta table — counting the per-agent deltas column, exactly 8 are ≤ 0 (Optimist 0.00, Pessimist −0.08, Architect −0.13, Auditor −0.05, Operator −0.19, Attacker −0.10, Pragmatist −0.04, Sr Engineer −0.07); Competitor +0.02 and Chaos Monkey +0.02 are positive. Claim verified.

## Job 4 — Methodology Conclusion Audit

Four claims to test:

- **σ 0.047 tighter than v10's 0.07 → convergence is real** — Mathematically correct. With identical evidence, 10 agents converged more tightly on the re-run, which supports the claim that the rubric + evidence doc reliably produces a stable number.
- **−0.06 mean drop → small anchoring effect** — Fair framing. The drop is inside the σ band of either round, so attributing it purely to "anchoring" vs "new findings dragging scores down on merit" is soft. The synthesis hedges appropriately: "Modest anchoring drift. Inside noise band."
- **True score is ~5.90 ± 0.1, not 5.96** — Honest. Explicitly states the number drifts ±0.05–0.10 across independent runs on identical state, so precision beyond 0.1 is noise. That's a stronger, more honest claim than v10 implied.
- **Assessment's value is finding bugs, not precision scoring** — Supported by the data. Five real new findings in one rerun, one hallucinated claim flagged. Bug-discovery rate dominates score precision as the meaningful output.

**Conclusion is fair.**

## Scores

- **Calibration: 9/10.** Arithmetic clean, findings hold under direct code verification, σ interpretation correct, conclusion appropriately hedged. One minor quibble: "anchoring" is one of several valid causal stories for the −0.06 drift; the synthesis commits to it without fully considering that new bugs discovered in v11 _should_ lower scores on merit, independent of anchoring. Not a correction-worthy defect.
- **Honesty: 10/10.** Flags its own hallucinated Pragmatist claim. Downgrades Security Posture by 0.26 on evidence that contradicts v10 credit. States precision limits directly. No rhetorical inflation, no hidden carve-outs.

No corrections required.
