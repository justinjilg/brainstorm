# Stochastic Assessment Audit v14 — 2026-05-15

11th Agent: Calibration & Bias Auditor.
Output verbatim per Phase 4 of `/stochastic-assessment` skill.

## Scores

- **Calibration: 6 / 10**
- **Honesty: 9 / 10**

Calibration below the 7-floor → **score override applied** (not synthesis
rewrite). Honesty above 7 → orchestrator synthesis stands as written.

## Calibration audit (per dim)

| Dim | Cite class      | Ruling                                                                                                                                                                                                             |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | class-2         | Auditor's −0.6 cited PR #302 fixes as if they were v14 _regressions_; the underlying bugs (br_health 401, memory enum, trajectory 404) were latent in v13's window. **Override toward v13.**                       |
| D2  | class-2         | 25/33 unparsed headers + 27-vs-45 package fan-out pre-existed v13. Newly enumerated. **Override toward v13.**                                                                                                      |
| D3  | class-2         | "Zero live BR contract probes" is a chronic absence, not a v14 loss. v14 actually added tests (PR #302 disabled-no-op). **Override toward v13.**                                                                   |
| D4  | class-2         | 42-day npm staleness is arithmetic against a v13-window publish; v13 scored 4.82 on the same underlying condition. **Override toward v13.**                                                                        |
| D5  | above baseline  | No audit needed (+0.11 cited).                                                                                                                                                                                     |
| D6  | class-2         | v13 Attacker bypasses still open were already absorbed into v13's 6.83 — re-deducting in v14 is double-counting. **Override toward v13.**                                                                          |
| D7  | class-2         | 27-vs-45 README drift + missing CHANGELOG pre-existed v13. v14 added docs (PRs #295, #298, #299). Score-down most clearly drift-driven. **Override toward v13.**                                                   |
| D8  | mixed → class-2 | Chaos Monkey "no try/catch around brainstorm-saas.ts upstream fetch" — the code pattern existed in v13. Strict-rubric reading: audit-depth gain, not regression. **Override toward v13; carry as v15 watch-item.** |
| D9  | class-2         | Per-session structural ceiling (no daemon, SQLite single-file) is architectural, scored in v13 on same observations. **Override toward v13.**                                                                      |
| D10 | above baseline  | No audit needed (+0.07 cited).                                                                                                                                                                                     |

## Synthesis bias audit

- No softening detected — Risk Register lists every critical finding (BR
  envelope drop 9/10, package drift 8/10, BR-down failover untested 4/10,
  v13 Attacker bypasses still open 5/10) in plain language matching or
  exceeding agent severity.
- No omission detected — every agent finding cross-referenced (10 agents
  in score matrix, 10 in per-agent overall table, 10 in single-action
  recommendations).
- No score inflation — recomputed all 10 means against the matrix:
  every reported mean matches recomputed within 0.005 (rounding artifact).
  Overall recomputed = 5.947 vs reported 5.948.
- No false optimism — the synthesis itself flagged calibration drift
  PROACTIVELY (lines 13-32, 51-72, 149-159) and offered the auditor an
  override path. Honest meta-disclosure, not optimism injection.
- No cherry-picking — discipline-lens vs critical-lens split is shown
  explicitly. Both extremes (Auditor −0.79, Optimist 6.83) surfaced.
- One borderline call: synthesis line 65 calls Chaos D8 cite "Borderline"
  where strict-rubric reading is class-2 (code pattern unchanged from v13).
  Synthesis hedged where the rubric is actually clear. Minor.
- One minor optimism: predicted post-audit overall "~6.20-6.30 range"
  (synthesis lines 157-158); actual = 6.122. Optimistic by 0.08-0.18.
  Worth correcting downward.

## Math reconciliation

- D1 reported 7.50; recomputed 7.500 ✓
- D2 reported 6.75; recomputed 6.750 ✓
- D3 reported 6.68; recomputed 6.680 ✓
- D4 reported 4.44; recomputed 4.442 ✓
- D5 reported 6.17; recomputed 6.170 ✓
- D6 reported 6.72; recomputed 6.715 ✓ (rounded)
- D7 reported 5.38; recomputed 5.375 ✓ (rounded)
- D8 reported 6.76; recomputed 6.760 ✓
- D9 reported 4.07; recomputed 4.070 ✓
- D10 reported 5.01; recomputed 5.010 ✓
- Overall reported 5.948; recomputed 5.947 ✓ (rounding)

## Corrected dimension means (post-override)

| Dim                     | v14 raw   | **v14 corrected** | v13       | Δ          |
| ----------------------- | --------- | ----------------- | --------- | ---------- |
| D1 CodeCompleteness     | 7.50      | **7.64**          | 7.64      | 0          |
| D2 Wiring               | 6.75      | **7.01**          | 7.01      | 0          |
| D3 TestReality          | 6.68      | **6.93**          | 6.93      | 0          |
| D4 ProductionEvidence   | 4.44      | **4.82**          | 4.82      | 0          |
| D5 OperationalReadiness | 6.17      | **6.17**          | 6.06      | **+0.11**  |
| D6 SecurityPosture      | 6.72      | **6.83**          | 6.83      | 0          |
| D7 Documentation        | 5.38      | **5.75**          | 5.75      | 0          |
| D8 FailureHandling      | 6.76      | **6.90**          | 6.90      | 0          |
| D9 ScaleReadiness       | 4.07      | **4.16**          | 4.16      | 0          |
| D10 ShipReadiness       | 5.01      | **5.01**          | 4.94      | **+0.07**  |
| **Overall**             | **5.948** | **6.122**         | **6.102** | **+0.020** |

## Verdict

**Baseline promoted to 6.122.** A modest +0.020 over v13, reflecting cited
capability gains (CodeQL drain, mkdtempSync TOCTOU fix, PR #302 BR-drift
cleanup, Phase-0 docs canonicalization, harness-\* package tests) with no
fresh-evidence regressions.

**Carry-forward to v15:** Chaos Monkey's D8 cite — `packages/providers/src/cloud/brainstorm-saas.ts`
has no try/catch around the upstream fetch; BR-down failover untested.
If still unaddressed next round, the audit-depth finding becomes a
quantified regression cite class-1.

**Note on calibration trend:** v13 σ across-agent was 0.047 (tightest
ever); v14 σ is 1.14 — a 24× widening. This is partly mechanical (integer
rubric clamping on a wider-spread roster of critical-lens findings) and
partly substantive (the critical-lens personas, esp. Auditor and Chaos
Monkey, did deeper code-by-grep audits than v13). Future rounds should
reinforce: critical-lens depth is GOOD; the calibration ratchet catches
when it crosses into score-down without cited regression.

## Path-to-90 confirmation

Mean per-dim gap to 9.0 (post-correction): **2.88 points.**

Dim-by-dim corrected gap:

- D1: 1.36
- D2: 1.99
- D3: 2.07
- D4: 4.18 (largest)
- D5: 2.83
- D6: 2.17
- D7: 3.25
- D8: 2.10
- D9: 4.84 (structurally gated)
- D10: 3.99 (partially gated)

D4 and D9 have structural ceilings that require Justin-level decisions
(public telemetry surface; daemon/multi-instance posture). D10 partially
gated on daemon decision. The plan in `docs/path-to-90-plan-2026-05-15.md`
calls these gates out.

For the 7 ungated dimensions (D1, D2, D3, D5, D6, D7, D8), mean gap is
**2.27 points** — achievable via the P1–P9 phases of the plan without
structural decisions.

---

Files referenced:

- `docs/assessment-evidence.md` — Phase 1 raw evidence (this round)
- `docs/assessment-synthesis.md` — Phase 3 orchestrator synthesis (this round)
- `docs/path-to-90-plan-2026-05-15.md` — remediation roadmap
- v15 baseline: corrected scores above
