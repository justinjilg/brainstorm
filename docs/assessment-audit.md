# v13 Calibration & Bias Audit — 2026-04-19

Auditor role: Calibration & Bias Auditor (11th agent).
Inputs: `assessment-evidence.md` and `assessment-synthesis.md`.
Baseline: v12 overall 5.97. v13 overall (claimed): 6.102.
Monotonicity invariant: no dimension mean below baseline unless regression cited.

---

## Job 1 — Calibration Audit

### 1.1 Arithmetic verification (independent recomputation)

I independently summed the 10 agent scores per dimension from the matrix in the synthesis. Results:

| Dimension             | My sum | /10   | Synthesis | Match |
| --------------------- | ------ | ----- | --------- | ----- |
| Code Completeness     | 76.40  | 7.640 | 7.640     | ok    |
| Wiring                | 70.06  | 7.006 | 7.006     | ok    |
| Test Reality          | 69.25  | 6.925 | 6.925     | ok    |
| Production Evidence   | 48.24  | 4.824 | 4.824     | ok    |
| Operational Readiness | 60.55  | 6.055 | 6.055     | ok    |
| Security Posture      | 68.30  | 6.830 | 6.830     | ok    |
| Documentation         | 57.52  | 5.752 | 5.752     | ok    |
| Failure Handling      | 68.95  | 6.895 | 6.895     | ok    |
| Scale Readiness       | 41.60  | 4.160 | 4.160     | ok    |
| Ship Readiness        | 49.35  | 4.935 | 4.935     | ok    |

Grand mean: sum of dimension means / 10 = 61.022 / 10 = **6.1022**, rounded to 6.10. Matches.

Per-agent overall spot checks:

- Attacker: 8.00+7.00+7.00+5.00+6.00+6.00+6.00+7.00+4.00+5.00 = 61.00 / 10 = **6.100** ok
- Pessimist: 7.60+6.90+6.80+4.78+5.90+6.80+5.67+6.80+4.05+4.88 = 60.18 / 10 = **6.018** ok (narrative 6.02)
- Sr Engineer: 7.80+7.20+7.00+4.78+6.10+7.10+5.80+7.00+4.30+5.00 = 62.08 / 10 = **6.208** ok (narrative 6.21)
- Competitor: 7.00+7.00+7.00+5.00+6.00+7.00+6.00+7.00+4.00+5.00 = 61.00 / 10 = **6.10** ok
- Chaos Monkey: 7.70+6.96+7.10+4.78+6.00+6.85+5.67+7.00+4.30+4.88 = 61.24 / 10 = **6.124** ok (narrative 6.12)

**Arithmetic is clean. No numeric inflation detected.** σ claim of 0.047 is plausible given the tight per-agent overall band (6.018 to 6.208).

### 1.2 Monotonicity audit

Every dimension mean in v13 is greater than or equal to v12. No dimension drop — invariant trivially holds at the aggregated level. Per-agent overalls are all at or above 5.97. ok

Within-dimension agent scores below v12 baseline (score-downs requiring cited regression):

- **Attacker, Security 6.00 vs v12 6.65 (-0.65).** Citations: three specific bypasses of new-in-v13 fixes — `npx vitest-pwn` prefix-match (no word-boundary in ALLOWED_GATE_PREFIXES), `go test -exec=/tmp/e` metachar gap, webhook nonce-cache bounded to 1000 entries so captured payloads replay after eviction. All three are enumerated with concrete inputs. **Monotonicity carve-out justified.**

- **Competitor, Code Completeness 7.00 vs v12 7.59 (-0.59).** Citation: 2 orphan router plugin files (`plugin-interface.ts`, `cost-first-plugin.ts`) committed as dead scaffolding. Real, cited, evidenced in evidence §7 and §12. **Monotonicity carve-out justified.** Magnitude is steep relative to 61 hardening commits, but within the same rubric bucket (7-8).

No other agent-dimension pair falls below v12. **Zero invariant breaches.**

### 1.3 Magnitude / calibration disagreement (>0.5 spread within a dimension)

Sweeping max-min within each dimension:

| Dimension             | Max                  | Min             | Spread   | Flag |
| --------------------- | -------------------- | --------------- | -------- | ---- |
| Code Completeness     | 8.00 (Att)           | 7.00 (Com)      | **1.00** | flag |
| Wiring                | 7.20 (SrE)           | 6.90 (Pes, Pra) | 0.30     | —    |
| Test Reality          | 7.10 (Cha)           | 6.80 (Pes, Arc) | 0.30     | —    |
| Production Evidence   | 5.00 (Att, Com)      | 4.78 (8 agents) | 0.22     | —    |
| Operational Readiness | 6.30 (Ops)           | 5.90 (Pes)      | 0.40     | —    |
| Security Posture      | 7.10 (SrE)           | 6.00 (Att)      | **1.10** | flag |
| Documentation         | 6.00 (Att, Com)      | 5.67 (6 agents) | 0.33     | —    |
| Failure Handling      | 7.00 (several)       | 6.75 (Pra)      | 0.25     | —    |
| Scale Readiness       | 4.30 (Aud, SrE, Cha) | 4.00 (Att, Com) | 0.30     | —    |
| Ship Readiness        | 5.00 (several)       | 4.88 (several)  | 0.12     | —    |

**Two dimensions with >0.5 spread:**

1. **Code Completeness spread 1.00** (Att 8.00 vs Com 7.00). The Attacker rewards that fixes were made; the Competitor punishes orphan files as competitive liability. Internally consistent (Att is highest on Code, lowest on Security — two sides of the same "new surface" coin). **Justified disagreement.**

2. **Security Posture spread 1.10** (SrE 7.10 vs Att 6.00). The Attacker's -0.65 carve-out. Synthesis preserves the spread in the mean (6.830, σ 0.289 — highest of any dimension). **Justified disagreement, correctly preserved.**

**Calibration concern (soft):** Competitor's -0.59 on Code Completeness is steep relative to 2 orphan files. Other agents seeing the same evidence scored 7.60-8.00. Synthesis correctly flags this as "widest downside swing" and does not override. I concur — keep, flag, do not clip.

### 1.4 Rubric-level match

Brainstorm is a local CLI, not a hosted service; several rubric levels are structurally capped.

- **Production Evidence** capped at 4.78 for 8 of 10 agents (local CLI, no `/health`, no uptime metric — evidence §13). Att and Com scored 5.00. Rubric 5 implies "some deployed surface + minimal monitoring." Brainstorm has neither, so 5.00 is mildly generous but stays in bucket (4-5). Soft burr, not a violation.
- **Scale Readiness** capped at 4.30 consensus-high. Rubric 4 = "single-machine, synchronous, no horizontal path." Matches. ok
- **Security Posture** consensus ~6.85. Rubric 6-7 = "most surfaces defended, some gaps, secrets handled." Matches v13 (webhook HMAC + kill-gate + allowedTools + O_EXCL locks, residual shell-string and exec-flag gaps). ok
- **Ship Readiness** 4.935. Rubric 5 = "ships to early adopters with known rough edges." Matches a v0.14 CLI. ok

### 1.5 Calibration violation count

**Zero hard violations.** Two soft flags:

- Competitor Code Completeness magnitude -0.59 (within bucket, within carve-out, magnitude steep).
- Att/Com Production Evidence 5.00 (marginally above structural cap 4.78).

Neither warrants a corrected synthesis.

**Calibration score: 8.5 / 10.**

---

## Job 2 — Synthesis Bias Audit

### 2.1 Per-agent narrative fidelity

| Agent             | Score                                                            | Narrative claim                                                                                                                                                                                                                                                                                                                   | Faithful? |
| ----------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Optimist 6.13     | "Hardening round; F7 closed is the biggest Ops win"              | ok                                                                                                                                                                                                                                                                                                                                |
| Pessimist 6.02    | "Orphans regress Wiring; 7 v12 findings unaddressed"             | ok                                                                                                                                                                                                                                                                                                                                |
| Architect 6.08    | "F7 closed + F9 added in same round — net ratchet gain"          | Mild **REFRAME** — dep-cruiser is RED on HEAD, calling it "net gain" leans positive.                                                                                                                                                                                                                                              |
| Auditor 6.09      | "All 4 spot-checked commits match claims; ratchet is cosmetic"   | Mild **SOFTENING** — "ratchet is cosmetic" reduces a universal risk (10/10) to a housekeeping item.                                                                                                                                                                                                                               |
| Operator 6.11     | "F7 closed at 0/0 is biggest Ops move; dep-cruiser RED caps"     | ok                                                                                                                                                                                                                                                                                                                                |
| Attacker 6.10     | "Three NEW bypasses of v13 fixes + carried F5"                   | ok                                                                                                                                                                                                                                                                                                                                |
| Competitor 6.10   | "Ahead of Aider/Continue; behind Claude Code on telemetry"       | Mild **OMISSION** — does not surface his own -0.59 Code Completeness regression, which is the steepest score-down in the entire matrix.                                                                                                                                                                                           |
| Pragmatist 6.06   | "Maturity moved; dep-cruiser RED trains team to ignore ratchets" | ok                                                                                                                                                                                                                                                                                                                                |
| Sr Engineer 6.21  | "4/4 fix commits grade A; regression tests exercise bug class"   | ok                                                                                                                                                                                                                                                                                                                                |
| Chaos Monkey 6.12 | "ENOSPC + Docker traps NOW closed with tests; busy_timeout open" | **REFRAME (borderline inflation).** Evidence §11 lists F8 (ENOSPC + Docker daemon death traps) under "outstanding, not addressed." Risk register row F8 clarifies "Cha says now closed." Synthesis narrative column asserts closure as fact. A hostile reader calls this cherry-picking Cha's sub-claim into the headline column. |

### 2.2 Score inflation

Arithmetic verified clean in §1.1. No inflation. Rounding follows convention (Pes 6.018→6.02, SrE 6.208→6.21, Cha 6.124→6.12). Headline 6.10 is honest rounding of 6.1022. ok

### 2.3 Findings omission check

Cross-referenced Risk Register against agent-level narrative:

- Dep-cruiser RED (10/10) — present. ok
- F10 telemetry (4/10 Arc/Aud/Pra/Ops) — present. ok
- F5 shell string-trick (4/10 Att/Pra/Arc/Cha) — present. ok
- F3 busy_timeout (3/10 Arc/Pra/Cha) — present. ok
- Zero `*.e2e.test.ts` (3/10 Aud/Pra/Att) — present. ok
- F8 ENOSPC/Docker (3/10 Pes/Arc/Pra with Cha disagreement) — present, with disagreement noted. ok
- F6 `/var/root/.ssh/` (3/10 Att/Pra/Arc) — present. ok
- 3 Attacker-specific new bypasses (1/10 Att) — all three present. ok
- Curator lock ownership check (1/10 Att) — present. ok
- F1 env scrub (1/10 Ops, Att disagreement) — present. ok
- F2 (0/10) — correctly recorded as not re-flagged. ok

**No register omissions.**

### 2.4 Reframing, added optimism, cherry-picking

- Closing sentence: _"A ratchet that catches its own ring's orphans in the same round that adds the ratchet is signal that the system is working."_ This is **ADDED OPTIMISM** in synthesis voice. Most agents who flagged dep-cruiser RED did not frame it as "the system is working"; only Arc's narrative is compatible with that spin. Acceptable as orchestrator commentary but should be labeled as such. Flag: low-medium.
- _"Disagreement IS the signal"_ in the Disagreement Hot-Spot section is synthesis voice but methodologically correct — it justifies preserving Attacker's -0.65 rather than clipping σ. This is GOOD behavior, not bias. ok

### 2.5 Calibration drift correction appropriateness

Synthesis §Calibration Drift Corrections says "None applied" and explicitly considers the Competitor -0.59, leaving it. I agree — evidence is real, magnitude within bucket, monotonicity invariant has a cited-regression carve-out. Clipping would hide σ that matters. No drift correction owed that wasn't applied.

### 2.6 Bias violation summary

| Type                    | Where                                           | Severity |
| ----------------------- | ----------------------------------------------- | -------- |
| SOFTENED                | Auditor row: "ratchet is cosmetic"              | Low      |
| REFRAME                 | Architect row: "net ratchet gain"               | Low      |
| REFRAME (borderline)    | Chaos Monkey row: "ENOSPC + Docker NOW closed"  | Low-Med  |
| OMISSION                | Competitor row: no mention of his -0.59 on Code | Low      |
| ADDED OPTIMISM          | Closing "system is working" framing             | Low-Med  |
| INFLATED SCORE          | None                                            | —        |
| CHERRY-PICKED AGENTS    | None (systematic)                               | —        |
| MISSED DRIFT CORRECTION | None                                            | —        |

**Five low / low-medium flags; zero high severity.**

**Honesty score: 7.5 / 10.**

---

## Decision on corrected synthesis

Both scores >= 7 (Calibration 8.5, Honesty 7.5). **No corrected synthesis required.**

Recommended annotations (do not change any score):

1. Chaos Monkey narrative: replace "ENOSPC + Docker traps NOW closed with tests" with "Cha claims NOW closed; evidence §11 still lists F8 outstanding — unresolved disagreement."
2. Auditor narrative: soften "ratchet is cosmetic" to "spot-checked commits match claims; dep-cruiser RED is cosmetic-per-Auditor, universal-risk-per-register."
3. Competitor narrative: add "scored Code Completeness 7.00 (-0.59) citing orphan plugin files" — the steepest within-agent delta deserves surfacing.
4. Closing "system is working" line: label as orchestrator commentary, not consensus.

Mean holds: **6.10**. Monotonicity holds. Arithmetic clean.

---

## Final scores

- **Calibration: 8.5 / 10**
- **Honesty: 7.5 / 10**
- **v13 overall 6.10 upheld.**
- **Monotonicity invariant upheld.**
- **Zero hard calibration violations; 5 low-severity bias flags.**
