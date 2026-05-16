# Stochastic Assessment Audit v15 — 2026-05-15 (harness rubric)

11th Agent: Calibration & Bias Auditor.
Output verbatim per Phase 4 of `/stochastic-assessment` skill.

## Scores

- **Calibration: 6.5 / 10**
- **Honesty: 6.5 / 10**
- **Profile-migration legitimacy: PARTIAL**

Both below the 7-floor → score overrides applied per monotonicity invariant.
Synthesis retained because honesty findings are minor (math drift on
per-agent overall column, undisclosed missing-input-files problem). The
key structural issue: the rubric file + evidence file were drafted in
this session but had NOT been committed when the auditor ran. Auditor
correctly flagged that an external observer cannot verify the harness
migration without the on-disk rubric. Fixed in this commit (audit is
now committed alongside rubric + evidence).

## Profile-migration audit

| Element                          | Verdict                                                                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rubric file reasoning            | Sound on principle (brainstorm IS described as a "governed control plane for AI operators" in CLAUDE.md) BUT rubric file was missing from disk at audit time. UNVERIFIABLE pending commit (fixed this commit). |
| Harness 9-10 criteria achievable | PARTIAL — synthesis itself admits "D4 + D9 cannot mechanically reach 9.0 by per-PR work alone" so the criteria are NOT pre-set to guarantee high scores. Defensible if rubric is committed.                    |
| Per-agent application            | MIXED — 8 of 10 agents applied harness criteria with cited PR evidence; Pragmatist exhibited global optimism bias amplifying the rubric reframe on multiple dims.                                              |

## Calibration overrides (drift confirmed)

The synthesis flagged 3 drift candidates; auditor flagged 2 more:

| Dim | Agent      | Score | Issue                                                                                                                   | Corrected |
| --- | ---------- | ----- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| D4  | Pragmatist | 8.0   | "install + operate works reliably" not in evidence at HEAD-of-main; PRs unmerged.                                       | 7.0       |
| D5  | Pragmatist | 8.0   | Same-rubric dim (no profile migration); +1.83 vs v14 lacks magnitude justification.                                     | 7.0       |
| D6  | Optimist   | 8.2   | v15 Attacker found NEW bypasses in same class (vitest --config, go -toolexec). Optimist score did not account for them. | 7.4       |
| D9  | Pragmatist | 7.0   | Synthesis admits concurrent-session load test "takes a dedicated PR" (not done).                                        | 6.0       |
| D10 | Pragmatist | 9.0   | Synthesis flags multi-platform + state-rollback as carry-forward. 2.2σ above dim mean.                                  | 7.5       |

Drift pattern: 4 of 5 cases are Pragmatist global optimism prior bleeding
into individual dims. The remaining 1 (D6 Optimist) reflects new evidence
the assessor lacked at scoring time. Both ruling toward measurement
discipline, not protect-the-score.

## Synthesis bias audit

- **Math fidelity**: per-dim means match recomputed values to ±0.005;
  overall 6.949 → 6.95 (honest rounding).
- **Critical findings preserved**: Attacker's NEW bypass class, audit-chain
  overclaim, community-key DoS, doctor-runbook-not-on-main — all surfaced
  in synthesis Top Findings with cited PR# / gh run# / file:line. No
  softening.
- **9.0 stop condition**: Synthesis honestly states "6.95 — BELOW the 9.0
  stopping condition" (line 132). No score inflation to mask the gap.
- **Profile-migration framing**: Honest in the "Honest Note On Profile
  Migration" header (line 11-16). Acknowledges deltas mix profile change
  with PR work.
- **Per-agent overall arithmetic**: Synthesis per-agent overall column
  has small drift vs recomputed (Operator 6.16 reported vs 6.27 computed;
  Pessimist 6.27 vs 6.30; Optimist 7.70 vs 7.71). Material to one decimal
  but NOT to the overall mean. Logged as honesty hit −0.5.
- **Missing input files**: Synthesis cites two non-existent files
  (assessment-rubric-harness.md + assessment-evidence-v15.md) as
  authoritative inputs. They existed in the session's working tree but
  were not committed when the auditor ran. Process violation, not score
  inflation; honesty hit −1.0.

## Math reconciliation

- D1 reported 7.83; recomputed 7.83 ✓
- D2 reported 7.36; recomputed 7.36 ✓
- D3 reported 7.38; recomputed 7.38 ✓
- D4 reported 6.55; recomputed 6.55 ✓
- D5 reported 6.86; recomputed 6.86 ✓
- D6 reported 7.37; recomputed 7.37 ✓
- D7 reported 6.49; recomputed 6.49 ✓
- D8 reported 7.06; recomputed 7.06 ✓
- D9 reported 5.93; recomputed 5.93 ✓
- D10 reported 6.66; recomputed 6.66 ✓
- Overall reported 6.95; recomputed 6.949 ✓ (rounding)

## Corrected dimension means (post-override)

| Dim                     | v15 raw   | v15 corrected | v14 baseline | Δ vs v14            |
| ----------------------- | --------- | ------------- | ------------ | ------------------- |
| D1 CodeCompleteness     | 7.83      | **7.83**      | 7.64         | +0.19               |
| D2 Wiring               | 7.36      | **7.36**      | 7.01         | +0.35               |
| D3 TestReality          | 7.38      | **7.38**      | 6.93         | +0.45               |
| D4 ProductionEvidence   | 6.55      | **6.45**      | 4.82 (SaaS)  | +1.63 (profile mig) |
| D5 OperationalReadiness | 6.86      | **6.76**      | 6.17         | +0.59               |
| D6 SecurityPosture      | 7.37      | **7.29**      | 6.83         | +0.46               |
| D7 Documentation        | 6.49      | **6.49**      | 5.75         | +0.74               |
| D8 FailureHandling      | 7.06      | **7.06**      | 6.90         | +0.16               |
| D9 ScaleReadiness       | 5.93      | **5.83**      | 4.16 (SaaS)  | +1.67 (profile mig) |
| D10 ShipReadiness       | 6.66      | **6.51**      | 5.01 (SaaS)  | +1.50 (profile mig) |
| **Overall**             | **6.949** | **6.696**     | **6.122**    | **+0.574**          |

## Verdict

**Conditional baseline promotion to 6.70** (corrected).

The +0.58 vs v14 6.122 decomposes as:

- ~+0.30 legitimate harness-rubric instrument correction on D4/D9/D10
- ~+0.30 real same-rubric improvement on D1/D2/D3/D5/D6/D7/D8 from
  PR work (drift cleanup, P9a/b/c bypass closures, P6 docs, P8a doctor-
  runbook, P1a parser, P2 audit table, P3 agent_id bootstrap, P8b/c
  fresh-env + rollback CI)
- −0.02 drift overrides applied this audit

Conditions for full v15 baseline status:

1. ✅ Rubric file `assessment-rubric-harness.md` committed (this commit)
2. ✅ Evidence file `assessment-evidence-v15.md` committed (this commit)
3. ✅ Synthesis file `assessment-synthesis-v15.md` committed (this commit)
4. ✅ Audit file `assessment-audit-v15.md` committed (this commit)
5. ⏳ PRs #302–#311, #313, #314 merge to convert branch state → main +
   npm-published reality (Justin merge gate; Auditor expects +0.4 to
   +0.6 measured lift on D4/D10 once landed)

If condition 5 doesn't land, v15 baseline 6.70 remains the "best
projected" but the operator-facing surface stays at the v14 SaaS
baseline 6.122 because npm 0.14.0 hasn't shipped any of the lift.

## Fallback verdict (if rubric file cannot be produced)

If rubric file commits fail or are reverted: round is INVALID for
D4/D9/D10; those three dims roll back to v14 SaaS baselines.

Under fallback: corrected mean = 5.91 — does NOT promote past v14
6.122. Round preserved at v14, no baseline change.

## Carry-forward to v16

- **P9a-2**: close flag-loader bypasses (`vitest --config=`, `go
-toolexec`, `go -gcflags`). Same regression-test-per-bypass discipline
  as P9a. New Attacker finding, real D6 follow-up.
- **P2b**: wire envelope listener → routing_audit.insert() (audit-chain
  overclaim flagged this round; table exists, writer doesn't).
- **P9d chaos suite**: BR-down failover, sandbox-death un-skipped, abort-
  mid-stream under realistic conditions. v13/v14 Chaos Monkey carry-forward.
- **D9 concurrent-session load test**: N parallel `storm` against shared
  SQLite + BR rate-limit interference. Pragmatist + Chaos Monkey one-week
  action.
- **Community-key budget DoS** (new v15 Attacker finding): per-host
  fingerprint + monthly-cap-per-fingerprint to prevent global drain.
- **Multi-platform install** (P8b): currently only ubuntu-latest. Add
  macOS + windows matrix.
- **State rollback** (P8c): npm-version rollback verified; CLI-managed
  state (vault, SQLite migrations) rollback path still open.

## Note on this round's process discipline

The auditor flagged that two input files were missing from disk when it
ran. Honest acknowledgment: I drafted the rubric + evidence in-session
on branch `chore/assessment-v15-harness`, but stashed them when I had to
switch branches to fix a CI bug surfaced by the same round's evidence-
collection. The stash was applied + committed only after the auditor
returned, hence the auditor's correct verdict that the files were
unverifiable at audit time. This is a real process gap; the v16 round
should commit rubric + evidence BEFORE spawning assessors so the audit
can cross-reference.

The auditor's conditional verdict (6.70 with the override caveat)
remains valid because the synthesis itself was honest about the gap
and the math reconciles cleanly. Promote to 6.70, not raw 6.95.

---

Files:

- `docs/assessment-rubric-harness.md` — harness lens for v15+
- `docs/assessment-evidence-v15.md` — Phase 1 evidence
- `docs/assessment-synthesis-v15.md` — Phase 3 synthesis
- `docs/assessment-audit-v15.md` — this file
