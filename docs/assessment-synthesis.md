# Stochastic Assessment Synthesis v11 — 2026-04-18 (methodology rerun)

Previous: v10 scored 5.96/10 (σ 0.07) earlier the same session. v11 is
a deliberate no-work replication — zero code changed since commit
01e8295 — to test whether v10's tight cross-agent agreement was real
signal or shared-evidence-doc anchoring.

## Overall Score: 5.90 / 10 (StdDev: 0.047)

Delta from v10: **−0.06 points.** Range: 5.82 (Chaos Monkey) to 5.98 (Competitor).

## Methodology-Test Findings

| Question                   | Answer                            | Evidence                                                                                         |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Is the tight σ real?       | **Yes.**                          | σ 0.047 < v10's 0.07. Agents reliably converge on the evidence.                                  |
| Was the v10 mean anchored? | **Partially.**                    | Mean drifted −0.06 on replication; 8/10 agents scored flat or lower. Not a large bias, but real. |
| Did new evidence emerge?   | **Yes — 5 substantive findings.** | See below. This is the more valuable output than the score.                                      |

## Per-Agent Deltas (v10 → v11)

| Agent        | v10      | v11      | Δ                                      |
| ------------ | -------- | -------- | -------------------------------------- |
| Optimist     | 5.93     | 5.93     | 0.00                                   |
| Pessimist    | 5.96     | 5.88     | −0.08                                  |
| Architect    | 5.99     | 5.86     | −0.13                                  |
| Auditor      | 5.93     | 5.88     | −0.05                                  |
| Operator     | 6.08     | 5.89     | **−0.19** (biggest drop, real finding) |
| Attacker     | 6.00     | 5.90     | −0.10 (new bypass found)               |
| Competitor   | 5.96     | 5.98     | +0.02                                  |
| Pragmatist   | 5.91     | 5.87     | −0.04                                  |
| Sr Engineer  | 6.04     | 5.97     | −0.07                                  |
| Chaos Monkey | 5.80     | 5.82     | +0.02                                  |
| **Mean**     | **5.96** | **5.90** | **−0.06**                              |

## 10-Agent Score Matrix (v11)

| Dimension             | A1   | A2  | A3   | A4   | A5   | A6   | A7   | A8   | A9   | A10  | Mean     | σ    | v10  | Δ         |
| --------------------- | ---- | --- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | -------- | ---- | ---- | --------- |
| Code Completeness     | 7.55 | 7.5 | 7.55 | 7.55 | 7.5  | 7.5  | 7.58 | 7.55 | 7.55 | 7.50 | **7.53** | 0.03 | 7.57 | −0.04     |
| Wiring                | 6.85 | 6.8 | 6.80 | 6.85 | 6.9  | 7.0  | 6.90 | 6.85 | 6.85 | 6.80 | **6.86** | 0.06 | 6.88 | −0.02     |
| Test Reality          | 6.60 | 6.5 | 6.55 | 6.65 | 6.5  | 6.6  | 6.70 | 6.55 | 6.80 | 6.55 | **6.60** | 0.09 | 6.62 | −0.02     |
| Production Evidence   | 4.80 | 4.8 | 4.75 | 4.75 | 4.75 | 4.75 | 4.75 | 4.75 | 4.80 | 4.75 | **4.77** | 0.03 | 4.78 | −0.01     |
| Operational Readiness | 5.75 | 5.7 | 5.70 | 5.70 | 5.8  | 5.6  | 5.72 | 5.75 | 5.75 | 5.70 | **5.72** | 0.05 | 5.76 | −0.04     |
| Security Posture      | 6.50 | 6.5 | 6.35 | 6.35 | 6.4  | 6.5  | 6.35 | 6.40 | 6.65 | 6.25 | **6.43** | 0.12 | 6.69 | **−0.26** |
| Documentation         | 5.60 | 5.6 | 5.60 | 5.55 | 5.7  | 5.5  | 5.60 | 5.60 | 5.95 | 5.53 | **5.62** | 0.12 | 5.68 | −0.06     |
| Failure Handling      | 6.60 | 6.5 | 6.55 | 6.55 | 6.6  | 6.6  | 6.55 | 6.55 | 6.55 | 6.45 | **6.55** | 0.05 | 6.64 | −0.09     |
| Scale Readiness       | 4.00 | 3.9 | 3.95 | 3.95 | 4.0  | 3.88 | 3.95 | 3.95 | 3.90 | 3.88 | **3.94** | 0.05 | 4.00 | −0.06     |
| Ship Readiness        | 5.00 | 4.8 | 4.80 | 4.85 | 4.7  | 5.0  | 4.74 | 4.80 | 4.85 | 4.80 | **4.83** | 0.10 | 5.00 | −0.17     |

All dimensions drifted downward. **Security Posture dropped most (−0.26)** because the Attacker found a real bypass (OP*SESSION*<accountid>) that invalidated part of v10's A2-closed credit. **Ship Readiness dropped −0.17** because Operator caught the unwired CI ratchet.

## New Substantive Findings (v11 uncovered; v10 missed)

These are the actual payload of running v11:

1. **CI ratchet is script-only, not CI-enforced** (Operator). `scripts/check-as-any-budget.mjs` exists and is runnable, but NO `.github/workflows/*.yml` step invokes it. Rapid regression can land silently through PR merge.

2. **`continue-on-error: true` on core + vault test steps** (Operator). "Green CI" badges pass even when test suites fail. Hides regressions.

3. **`OP_SESSION` scrub uses exact-match** (Attacker). 1Password CLI exports session tokens as `OP_SESSION_<accountid>` (e.g., `OP_SESSION_abc123xyz`). The explicit name set has bare `OP_SESSION` only; the regex `/(?:API_KEY|SECRET|PASSWORD|CREDENTIALS|PRIVATE_KEY|_TOKEN)/i` does NOT match `OP_SESSION_*`. Real session token leaks to shell children under "restricted" default.

4. **Restricted sandbox does not block sensitive file reads** (Attacker). Default `"restricted"` only blocks command PATTERNS (rm, sudo, curl-pipe-sh). An attacker with shell can `cat ~/.aws/credentials ~/.ssh/id_rsa ~/.netrc ~/.config/op/config.json` — none are blocked. Host filesystem-sandbox is only in "container" mode.

5. **No `busy_timeout` pragma on SQLite** (Chaos Monkey). `packages/db/src/client.ts` sets `journal_mode=WAL` and `foreign_keys=ON` but NO `busy_timeout`. Desktop + CLI both opening `~/.brainstorm/brainstorm.db` produce immediate `SQLITE_BUSY` on first concurrent write. Multi-window risk is architectural, not just untrapped.

## False Finding Flagged by This Synthesis

- **Pragmatist (A8) claimed "8 modified tracked files exist"** — `git status` shows 0. The claim is stale/hallucinated. Score contribution unchanged.

## Risk Register (v11 consensus)

| Risk                                                    | Count        | Notes                                                   |
| ------------------------------------------------------- | ------------ | ------------------------------------------------------- |
| Multi-window SQLite concurrent writes (no busy_timeout) | **7/10**     | NEW ANGLE this round: architectural, not just untrapped |
| ENOSPC / disk-full mid-DB-write untrapped               | 3/10         | From v10                                                |
| Docker daemon death mid-sandbox untrapped               | 2/10         | From v10                                                |
| Auto-updater GitHub supply-chain trust                  | 3/10         | Structural                                              |
| Zero production telemetry                               | 3/10         | Structural                                              |
| Parallel turbo test flake unchanged                     | 3/10         | From v10                                                |
| Inspection-only S4/S6/S7 closures                       | 2/10         | From v10                                                |
| CI ratchet not actually in CI                           | **1/10 NEW** | Real gap                                                |
| `continue-on-error` masks test failures                 | **1/10 NEW** | Real gap                                                |
| OP*SESSION*<accountid> scrub bypass                     | **1/10 NEW** | Real bug                                                |
| Restricted sandbox allows sensitive file reads          | **1/10 NEW** | Real design gap                                         |
| Grep-based as-any counter is brittle                    | 1/10         | Minor                                                   |
| Docker `--user=1000:1000` vs host UID mismatch          | 1/10         | From v10                                                |
| No dep-cruiser                                          | 1/10         | From v10                                                |
| No jsdom+RTL                                            | 1/10         | From v10                                                |

## Calibration Assessment

- **σ:** 0.07 → 0.047 (tighter). Agent convergence on the evidence is real.
- **Mean:** 5.96 → 5.90 (−0.06). Modest anchoring drift. Inside noise band.
- **Substantive net:** 5 new real findings vs 1 false finding. Strong signal that the assessment _produces value_ through re-running, not just scoring.

## What This Tells Us About Methodology

Running the assessment twice on the same no-work state:

- Confirms σ is small enough that 10 agents on the same evidence doc produce a stable number ± 0.07.
- But the **number itself drifts ±0.05–0.10** across independent runs even on identical state — so reporting precision beyond 0.1 is false signal.
- The **new-finding rate** is the more valuable output. v11 found 5 substantive items v10 missed in ~5 minutes of agent time.
- Ideal methodology: re-run v11-style replication anytime a round produces σ < 0.1 on a significant delta, to distinguish real progress from anchoring.

## Recommended Immediate Action (Pass 27)

Fix the 5 v11-new findings in priority order:

1. **OP_SESSION bypass** (A6) — highest severity; session token exfil. Change `SCRUBBED_ENV_NAMES` check to prefix-match or add `OP_SESSION` to the regex.
2. **busy_timeout pragma** (A10) — architectural; one-line fix closing the multi-window collision path.
3. **CI ratchet wire-up** (A5) — make the governance claim real, not aspirational.
4. **Fix `continue-on-error` on tests** (A5) — restore CI signal integrity.
5. **Restricted sandbox file-read block** (A6) — add `~/.ssh/*`, `~/.aws/*`, `~/.netrc`, `~/.config/op/*` to sandbox's sensitive-path blocklist OR clearly document users should run untrusted workloads under "container".

## Delta Summary

**v10 5.96 → v11 5.90 (−0.06).** Three-round trajectory: v8 5.36 → v9 5.76 → v10 5.96 → v11 5.90.

Taking v11 as the corrected baseline (the methodology rerun is a better point-estimate than the biased original), two-round gain since v8 is **+0.54**, not the +0.60 v10 suggested. Still substantial, but not as large.

More importantly: the number is directional at ±0.1 precision. Finer claims are noise.
