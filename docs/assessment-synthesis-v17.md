# Stochastic Assessment Synthesis v17 — 2026-05-16

**Round:** v17 (post v16 follow-ups + v0.14.3 publish)
**Orchestrator:** Claude Code (this session)
**Protocol:** `/stochastic-assessment`, harness rubric
**Baseline:** v16 verdict 6.94 (`docs/assessment-audit-v16.md`)
**Evidence:** `docs/assessment-evidence-v17.md`

## Phase 3 — Mechanical synthesis

### Score matrix

| Agent       | D1  | D2  | D3  | D4   | D5  | D6  | D7  | D8  | D9  | D10 | Overall |
| ----------- | --- | --- | --- | ---- | --- | --- | --- | --- | --- | --- | ------- |
| Optimist    | 7.8 | 7.2 | 7.3 | 6.5  | 7.3 | 7.5 | 7.1 | 7.4 | 6.6 | 7.5 | 7.22    |
| Pessimist   | 7.0 | 6.0 | 6.5 | 5.5  | 6.5 | 7.1 | 6.0 | 6.5 | 6.5 | 6.0 | 6.45    |
| Architect   | 7.7 | 7.0 | 7.0 | 5.75 | 7.0 | 7.5 | 8.0 | 7.0 | 6.5 | 7.0 | 7.15    |
| Auditor     | 7.0 | 6.5 | 7.0 | 5.5  | 7.0 | 7.0 | 7.0 | 7.0 | 6.5 | 5.7 | 6.92    |
| Operator    | 8.0 | 8.0 | 7.0 | 7.0  | 7.5 | 7.0 | 7.0 | 7.0 | 7.0 | 7.0 | 7.35    |
| Attacker    | 8.0 | 7.0 | 7.0 | 5.5  | 7.0 | 6.5 | 7.0 | 8.0 | 6.5 | 7.2 | 6.97    |
| Competitor  | 8.0 | 7.4 | 7.4 | 7.0  | 8.0 | 8.0 | 7.0 | 7.4 | 7.0 | 7.5 | 7.48    |
| Pragmatist  | 8.0 | 6.0 | 7.0 | 6.0  | 7.0 | 7.7 | 7.0 | 8.2 | 7.0 | 6.0 | 7.00    |
| SrEngineer  | 7.9 | 6.5 | 7.4 | 6.0  | 7.0 | 7.5 | 7.0 | 7.7 | 6.8 | 7.6 | 7.14    |
| ChaosMonkey | 7.0 | 6.5 | 7.0 | 5.5  | 7.0 | 7.0 | 7.0 | 7.5 | 7.0 | 7.0 | 6.91    |

### Per-dimension stats (vs v16)

| Dim                      | v17 Mean | Stddev | v16 Base | Delta     |
| ------------------------ | -------- | ------ | -------- | --------- |
| D1 Code Completeness     | 7.64     | 0.46   | 7.66     | -0.02     |
| D2 Wiring                | 6.81     | 0.65   | 7.02     | -0.21     |
| D3 Test Reality          | 7.06     | 0.27   | 7.04     | +0.02     |
| D4 Production Evidence   | 6.03     | 0.65   | 5.75     | **+0.28** |
| D5 Operational Readiness | 7.13     | 0.40   | 7.10     | +0.03     |
| D6 Security Posture      | 7.28     | 0.42   | 7.06     | **+0.22** |
| D7 Documentation         | 7.01     | 0.49   | 6.98     | +0.03     |
| D8 Failure Handling      | 7.37     | 0.51   | 7.22     | **+0.15** |
| D9 Scale Readiness       | 6.74     | 0.21   | 6.50     | +0.24     |
| D10 Ship Readiness       | 6.85     | 0.74   | 7.05     | **-0.20** |

**Grand mean: 7.06 (Δ +0.12 vs v16 baseline 6.94)**
**Per-agent overall stddev: 0.28** (tightest consensus yet)
**Range: 6.45 (Pessimist) ↔ 7.48 (Competitor)**

### Calibration check

No high-variance flags (all stddevs < 1.5).

Two dimensions had legitimate cited deltas with attention warranted:

- **D10 −0.20** (Ship Readiness): The new v17 evidence captured Rollback Drill in a transient FAILED state (just before v0.14.3 publish completed). Pessimist + Auditor + Pragmatist all docked here. The most recent Rollback Drill run on main (2026-05-16T11:50:45Z, post v0.14.3) is GREEN — but the evidence snapshot taken at 04:48 PT showed the older fail. Materially, the drill works on v0.14.3; the evidence under-represents reality. Synthesis preserves the cited score (evidence is the contract) but flags for v17.1 evidence refresh.

- **D2 −0.21** (Wiring): driven by Auditor's claim that `deleteOlderThan` has zero production callers. **CALIBRATION VIOLATION** — verified independently: the equivalent SQL DELETE statement is wired at `packages/db/src/client.ts:83` inside the `cleanupOldRecords` statements array. The Auditor grepped only for the method name, missing the parallel direct-SQL invocation that does the same thing. The 11th auditor should rule on this.

### Risk register (sorted by count)

| Risk                                                                                                         | Count | Notes                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ----- | --------------------------------------------------------------------- |
| Rollback Drill flaky/transient red on main                                                                   | 6/10  | Latest run actually GREEN; evidence snapshot stale                    |
| 7 packages stuck at 0.1.0 on npm (dispatch-sdk, endpoint-stub, relay, sandbox\*, harness-loop, msp-executor) | 3/10  | Real — being addressed in v0.14.4 work-in-flight                      |
| Release (Changesets) workflow permanently broken (ValidationError)                                           | 3/10  | Real — sdk/onboard depend on ignored eval/docgen/ingest               |
| atomicReplaceFile widens permissions (0600 → 0644)                                                           | 1/10  | **REAL REGRESSION I INTRODUCED** — Attacker found, fixed this session |
| DANGER_PATTERNS list has named holes (bun --preload, deno --import-map, pytest -c, etc.)                     | 1/10  | Attacker                                                              |
| seenEventIds Map RAM-only — restart wipes dedupe                                                             | 1/10  | Chaos Monkey (carry from v16)                                         |
| Worktree 32-bit entropy in /tmp                                                                              | 1/10  | Attacker (carry from v16)                                             |
| CLI god-object (28 internal deps)                                                                            | 1/10  | Architect                                                             |
| file-write.ts + multi-edit.ts un-fsynced tmp-rename                                                          | 1/10  | Chaos Monkey                                                          |
| atomicReplaceFile cross-device rename (EXDEV)                                                                | 1/10  | Chaos Monkey                                                          |

### Strengths (most cited)

| Strength                                                                   | Count |
| -------------------------------------------------------------------------- | ----- |
| 3 v16 Attacker classes verifiably closed (server token, kill-gate, dedupe) | 6/10  |
| Mapped-type drift fix (compile-time enforcement)                           | 5/10  |
| routing_audit retention wired via cleanupOldRecords                        | 4/10  |
| Auto-discover publish workflow eliminated drift                            | 4/10  |
| 32 packages on npm at 0.14.3 (was 23 at 0.14.1)                            | 4/10  |
| Atomic file-edit (fsync + rename)                                          | 3/10  |
| Operator-grade error messages (downgrade-guard, doctor-runbook)            | 2/10  |

### Synthesis paragraph

v17 measures **7.06** (Δ +0.12 vs v16 6.94). Per-agent stddev 0.28 — tightest yet. The v16 named regressions are each verified closed (3 Attacker classes wired through, retention wired, drift hole closed with mapped type, edit atomicity wired). Two scoring drops have cited evidence: D10 (-0.20) reflects an evidence-snapshot timing artifact — the Rollback Drill ran red on the v17 evidence-capture timestamp but ran GREEN on the very next scheduled run after v0.14.3 publish completed. D2 (-0.21) reflects a likely calibration error by the Auditor who grepped only for the deleteOlderThan method name and missed the parallel SQL DELETE invocation at client.ts:83. The 8.5 hook target is not reached; per the v16 11th auditor, the structural ceiling is ~8.5 contingent on operator-adoption signal (D4) and chaos-at-scale (D9) evidence not measurable inside a single round. v17's gains are real and structural (+0.28 D4, +0.22 D6, +0.15 D8, +0.24 D9), but the rate-of-gain is bounded by the rubric's "harness reading" semantics.

**Recommended next actions for v18**:

1. v0.14.4 publish with the 7 stuck-at-0.1.0 packages bumped + permission-preservation fix in atomicReplaceFile + DANGER_PATTERNS extensions for bun/deno/pytest -c/cargo --mod
2. Fix `.changeset/config.json` `sdk → docgen/ingest` validation error so Release (Changesets) goes green
3. Refresh evidence on a stable main (no in-flight workflows) so D10 measures true state
4. Persist seenEventIds to SQLite so restart doesn't wipe dedupe (Chaos Monkey)
5. Lift atomicReplaceFile into shared helper + flock target (Chaos Monkey ask)
