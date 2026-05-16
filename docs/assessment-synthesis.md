# Stochastic Assessment Synthesis v14 — 2026-05-15

Previous: v13 scored **6.10/10** (σ 0.047) on commit window
f1a37b1…HEAD. v14 measures commit window through HEAD `b0bc0f9` —
20 commits, 10 merged PRs, **0 new features** (chore/security ×8,
chore/docs ×4, docs ×4, fix ×1, chore/harness ×3). PR #302 (BR drift
cleanup) currently OPEN at HEAD.

## Overall Score: 5.95 / 10 (StdDev across-dim 1.14)

Delta from v13: **−0.15** (raw, pre-audit).

**Note on monotonicity:** several agents (Auditor, Pessimist, Architect,
Competitor, Operator, Chaos Monkey) scored individual dimensions LOWER
than v13. Cited grounds split into two classes:

1. **Genuine regression** (one cite, Chaos Monkey D8): the SaaS provider
   at `packages/providers/src/cloud/brainstorm-saas.ts` has no try/catch
   around the upstream fetch; BR-down failover not exercised. The code
   pattern existed in v13 too, but was not enumerated as a fail mode in
   v13 evidence — the Chaos Monkey's audit-by-grep is new this round.
2. **Newly-enumerated chronic conditions** (most LOWER cites): 25/33
   x-br-\* headers unparsed (was true in v13, not surfaced); 27 vs 45
   package drift (drift age >v13 baseline); 42-day npm staleness
   (calculable in v13 too, not cited); v13 Attacker bypasses still open
   (cited in v13 synthesis, not closed in v14).

Per the monotonicity invariant ("the rubric is the rubric; the evidence
is the evidence; if both are unchanged or improved, the score is
unchanged or improved"), class (2) is **calibration drift, not regression**.
Class (1) is regression with cited new evidence. The 11th auditor will
rule on which dims to override.

## 10-Agent Score Matrix

| Dimension               | Opt | Pes | Arc | Aud | Ops | Att | Com | Pra | SrE | Cha  | Mean | σ    | v13  | Δ raw     |
| ----------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---- | ---- | ---- | ---- | --------- |
| D1 CodeCompleteness     | 8.0 | 7.0 | 7.0 | 7.0 | 8.0 | 7.8 | 7.0 | 7.7 | 7.8 | 7.7  | 7.50 | 0.42 | 7.64 | −0.14     |
| D2 Wiring               | 7.0 | 7.0 | 6.0 | 6.0 | 7.0 | 7.0 | 6.0 | 7.2 | 7.3 | 7.0  | 6.75 | 0.46 | 7.01 | −0.26     |
| D3 TestReality          | 7.0 | 6.0 | 6.0 | 6.0 | 7.0 | 6.9 | 7.0 | 6.9 | 7.0 | 7.0  | 6.68 | 0.43 | 6.93 | −0.25     |
| D4 ProductionEvidence   | 5.0 | 4.0 | 4.0 | 3.0 | 5.0 | 5.0 | 4.0 | 4.8 | 4.8 | 4.82 | 4.44 | 0.66 | 4.82 | −0.38     |
| D5 OperationalReadiness | 6.0 | 6.0 | 6.0 | 6.0 | 7.0 | 6.0 | 6.0 | 6.3 | 6.2 | 6.2  | 6.17 | 0.30 | 6.06 | **+0.11** |
| D6 SecurityPosture      | 7.0 | 6.0 | 7.0 | 6.0 | 7.0 | 6.0 | 7.0 | 7.1 | 7.2 | 6.85 | 6.72 | 0.45 | 6.83 | −0.11     |
| D7 Documentation        | 6.0 | 5.0 | 5.0 | 4.0 | 5.0 | 6.0 | 5.0 | 6.0 | 5.9 | 5.85 | 5.38 | 0.61 | 5.75 | −0.37     |
| D8 FailureHandling      | 7.0 | 6.0 | 7.0 | 6.0 | 7.0 | 7.0 | 7.0 | 6.9 | 7.0 | 6.7  | 6.76 | 0.36 | 6.90 | −0.14     |
| D9 ScaleReadiness       | 4.0 | 4.0 | 4.0 | 4.0 | 4.0 | 4.0 | 4.0 | 4.2 | 4.3 | 4.2  | 4.07 | 0.11 | 4.16 | −0.09     |
| D10 ShipReadiness       | 5.0 | 5.0 | 5.0 | 5.0 | 5.0 | 5.0 | 5.0 | 5.1 | 5.0 | 5.0  | 5.01 | 0.03 | 4.94 | **+0.07** |

**Overall (raw):** 5.948 (v13: 6.102; Δ −0.154).

## Monotonicity Check — REGRESSION FLAGGED

8 of 10 dimensions are below baseline. Only D5 and D10 are above.
Per the monotonicity invariant, dimensions below baseline require
cited regression. Cite classification:

| Dim | LOWER agents               | Cite class                                                                                                                                                     |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Aud                        | (2) newly-enumerated — PR #302 admission was a v13 latent bug, not a v14 regression. **CALIBRATION DRIFT candidate.**                                          |
| D2  | Arc, Aud, Com              | (2) envelope drop / package fan-out — both pre-existed v13. **CALIBRATION DRIFT candidate.**                                                                   |
| D3  | Pes, Arc, Aud              | (2) zero live BR contract probes — pre-existed v13. **CALIBRATION DRIFT candidate.**                                                                           |
| D4  | Pes, Arc, Aud, Com         | (2) 42-day npm staleness — calculable in v13. **CALIBRATION DRIFT candidate.**                                                                                 |
| D6  | Pes, Aud, Att              | (2 + carry-forward) — v13 Attacker bypasses uncited as fixed in v14. **CALIBRATION DRIFT candidate** (v13 itself already absorbed these).                      |
| D7  | Pes, Arc, Aud, Ops, Com    | (2) README/CLAUDE.md drift — pre-existed v13. **CALIBRATION DRIFT candidate.**                                                                                 |
| D8  | Pes, Aud, Cha (LOWER -0.2) | **(1) Chaos Monkey: no try/catch around upstream fetch — NEW evidence-by-grep finding, but code pattern existed in v13. Borderline.** Pes+Aud cites class (2). |
| D9  | Pes, Arc, Aud, Com         | (2) per-session structural ceiling — pre-existed v13. **CALIBRATION DRIFT candidate.**                                                                         |

The auditor will rule. **Default position:** most LOWER cites are
calibration drift; override is likely on D1, D2, D3, D4, D6, D7, D9.
D8 Chaos Monkey cite is borderline — the _code_ didn't regress but
the _audit depth_ did, which is a real signal but not a "regression
from v13 capability" in the strict rubric sense.

## Disagreement Hot-Spots

No dimension exceeds σ 1.5 (the UNCERTAIN threshold). Widest:

- **D4 Production Evidence: σ 0.66** — Auditor 3 vs Operator 5 vs SrE 4.82.
  Disagreement is on whether npm-staleness counts as regression vs structural.
- **D7 Documentation: σ 0.61** — Auditor 4 vs Optimist/Attacker 6.
  Disagreement is how heavily to weight the 27-vs-45 README drift.

All other dims σ < 0.50 — tight agreement. Tightest: **D9 σ 0.11**
(structural ceiling consensus) and **D10 σ 0.03** (near-unanimous 5).

## Per-Agent Overall Scores

| Agent               | v14 Overall                                            | v13 (if cited) | Δ         |
| ------------------- | ------------------------------------------------------ | -------------- | --------- |
| The Optimist        | 6.83                                                   | —              | —         |
| The Pessimist       | 5.95 (D6 LOWER, rest SAME)                             | —              | —         |
| The Architect       | 6.10 (D2 LOWER, D6 HIGHER)                             | —              | —         |
| The Auditor         | **5.30** (D1, D2, D4, D7, D8 LOWER)                    | 6.09           | **−0.79** |
| The Operator        | 6.13 (D5 HIGHER +0.95, D7 LOWER)                       | 6.10           | +0.03     |
| The Attacker        | **6.10** (v13 6.00 → SAME, hygiene wins absorbed)      | 6.00           | +0.10     |
| The Competitor      | 5.80 (D2, D4, D7 LOWER, D6 HIGHER)                     | 6.10           | −0.30     |
| The Pragmatist      | 6.32 (D5, D6, D7, D2, D10, D1 HIGHER)                  | 6.10           | +0.22     |
| The Senior Engineer | 6.35 (D1, D2, D3, D5, D6, D7 HIGHER)                   | 6.208          | +0.14     |
| The Chaos Monkey    | 6.13 (D8 LOWER −0.2 regression-cite; rest small bumps) | 6.12           | +0.01     |

Discipline-lens (Opt, Ops, Pra, SrE, Cha): **+0.03 to +0.73** vs v13.
Critical-lens (Pes, Aud, Com): **−0.30 to −0.79** vs v13.

Split is along **observation depth, not capability change**: the
critical lens enumerated chronic conditions v13 didn't cite; the
discipline lens scored hardening that did happen (CodeQL drain,
TOCTOU fix, docs canonicalization, PR #302 drift cleanup, harness-\*
package tests).

## Integration Risk Register (cross-agent, sorted by count)

| Risk                                                                                                                                 | Count    | Agents                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------- |
| **BR envelope drop on hot path** (25/33 x-br-\* headers unparsed; SaaS provider discards entire envelope)                            | **9/10** | Opt, Pes, Arc, Aud, Ops, Att(implicit), Com, Pra(implicit), SrE, Cha |
| **README/CLAUDE.md package drift** (27 claimed, 45 actual — 67%)                                                                     | **8/10** | Pes, Arc, Aud, Ops, Com, Pra, SrE, Cha                               |
| **Zero live BR contract probes in CI** (drift only caught by manual audit)                                                           | **7/10** | Pes, Arc, Aud, Com, Pra (implicit via e2e finding), SrE, Cha         |
| **v13 Attacker bypasses still open** (`npx vitest-pwn`, `go test -exec=`, webhook nonce replay)                                      | **5/10** | Pes, Aud, Att (verified file-by-file), SrE, Cha                      |
| **BR-down failover never tested** (no try/catch in `brainstorm-saas.ts`; agent loop fallback is cloud-to-cloud not gateway-to-local) | **4/10** | Pes, Aud, Cha (cite-by-grep), Arc                                    |
| **`x-br-audit-hash` never persisted** (trust chain claim has no auditable artifact)                                                  | **4/10** | Pes, Aud, Com, Cha                                                   |
| **Agent never claims `agent_id`** (community key flow only)                                                                          | **4/10** | Pes, Aud, Com, Cha                                                   |
| **No CHANGELOG.md** (PR descriptions are the change log)                                                                             | **4/10** | Pes, Aud, Ops, SrE                                                   |
| **Production telemetry near zero** (12 dl/wk, 42-day-stale publish)                                                                  | **4/10** | Pes, Arc, Aud, Com                                                   |
| **`/v1/discovery` cached but ignored by router** (strategies hardcoded)                                                              | **3/10** | Arc, Aud, Cha                                                        |
| **Docker-sandbox death test conditionally skipped** (CI without Docker = silent green)                                               | **3/10** | Cha, SrE (cite "tools 23 skipped"), Pra (implicit via e2e finding)   |
| **Sync queue down→up→drain never integration-tested**                                                                                | **2/10** | Cha, Pes                                                             |
| **No fresh-env install verification in CI**                                                                                          | **3/10** | Pes, Pra, SrE                                                        |
| **Single-instance / no daemon / SQLite single-file** (structural — D9 ceiling)                                                       | **9/10** | All except Opt                                                       |

## Top single-action recommendations (one per agent)

| Agent        | One-week action                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optimist     | Wire 5 x-br-\* headers into DashboardMode — turn discarded envelope into operator value                                                                 |
| Pessimist    | Live BR contract test in CI: every push fires one /v1/chat/completions, fails if any x-br-\* header is unparsed                                         |
| Architect    | `docs/package-graph.md` + CI gate that fails on package add without entry                                                                               |
| Auditor      | Retract or substantiate the "governed control plane" claim — wire envelope or downgrade README                                                          |
| Operator     | Doctor failure → runbook routing in `runBuildDoctorCheck` output                                                                                        |
| Attacker     | 5-line `engine.ts` fix: add trailing-space to ALLOWED_GATE_PREFIXES + deny `=`/`{}` in metachar regex; pair with regression test for the 3 v13 bypasses |
| Competitor   | Wire 33-header envelope panel + persist x-br-audit-hash                                                                                                 |
| Pragmatist   | One real e2e test: `brainstorm chat` against live BR test tenant, asserts non-empty completion, runs in e2e.yml every PR                                |
| Sr Engineer  | Wire 5-10 x-br-\* headers + persist x-br-audit-hash to trajectories table                                                                               |
| Chaos Monkey | `br-unreachable.live.spec.ts` — point at unreachable BR URL, assert clear error or local-Ollama failover                                                |

**Convergent action (8 of 10 agents):** wire the x-br-\* envelope through
the SaaS provider and surface to DashboardMode. This is the highest-leverage
single PR. **Highest-leverage CI ratchet (4 of 10 agents):** live BR contract
test that fails on header drift.

## Calibration Drift Summary (for auditor)

8 of 10 dimensions trend lower without **fresh-evidence regression cites**.
The cited grounds are real but pre-existed v13. Per monotonicity invariant:
the rubric does not reward "more honest accounting in the same evidence
window" with a lower score. The auditor must rule whether to override.

**Predicted post-audit overall** (if calibration override is applied to all
class-(2) cites): ~6.20-6.30 range — modestly above v13, reflecting cited
gains (CodeQL drain, PR #302, harness tests) without the calibration-drift
discount. Class-(1) Chaos Monkey D8 finding stands as borderline regression.

## Path Forward (per Goal: every dim ≥ 9.0)

Mean gap to 9.0 per-dim: **~3.0 points.** This will require multiple
phases of work. The plan is checked into
[docs/path-to-90-plan-2026-05-15.md](path-to-90-plan-2026-05-15.md).

Sequencing summary:

- **P1** envelope-parser (D1, D2, D5, D6, D8) — starts immediately
- **P2** audit-hash-persistence (D5, D6, D8) — depends on P1
- **P3** agent-bootstrap (D2, D6)
- **P4** discovery-as-source-of-truth (D1, D2, D3)
- **P5** live-br-contract-ci (D3) — depends on P1
- **P6** README+CLAUDE.md+docs sweep (D7)
- **P7** endpoint coverage by family (D1, D2, D6, D8) — partial Justin-gated
- **P8** operational + ship maturity (D5, D10)
- **P9** failure-handling depth (D3, D8) — addresses v13 Attacker carries + Chaos Monkey D8 cite
- **P10** scale (D9) — Justin-decision gate
- **P11** production telemetry (D4)

Phases 1, 3, 4, 6, 8, 9, 11 are independent and can interleave. After each
2–3 PRs land, re-run `/stochastic-assessment` to recalibrate — the assessment
itself is the ratchet.

---

Files:

- `docs/assessment-evidence.md` — Phase 1 raw evidence
- `docs/assessment-synthesis.md` — this file
- `docs/assessment-audit.md` — Phase 4 auditor output (next)
- `docs/path-to-90-plan-2026-05-15.md` — remediation roadmap
