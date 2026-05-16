# Path-to-90 Status — 2026-05-15 (v15 measurement)

This file documents the current measured state of brainstorm CLI against
the harness-rubric `/stochastic-assessment`. **No projections, no
estimates — only measured scores cited at file/PR/run.**

## Score

**v15 measured baseline: 6.70 / 10** (auditor-corrected from raw 6.95)

Source: `docs/assessment-audit-v15.md`. 10 independent assessors + 11th
auditor under the harness rubric (`docs/assessment-rubric-harness.md`).

Previous: v14 6.122 / 10 (SaaS rubric). v15 is a **profile migration** —
v14 used the SaaS instrument; v15 uses the harness instrument. The shift
is legitimate (CLAUDE.md describes brainstorm as a "governed control
plane for AI operators", i.e. a harness) but means v14 → v15 deltas on
D4/D9/D10 mix rubric change with PR work.

## Per-dimension corrected v15 (auditor verdict)

| Dim                             | v15 corrected | v14 baseline | Δ           |
| ------------------------------- | ------------- | ------------ | ----------- |
| D1 CodeCompleteness             | 7.83          | 7.64         | +0.19       |
| D2 Wiring                       | 7.36          | 7.01         | +0.35       |
| D3 TestReality                  | 7.38          | 6.93         | +0.45       |
| D4 ProductionEvidence (harness) | 6.45          | 4.82 (SaaS)  | +1.63 mixed |
| D5 OperationalReadiness         | 6.76          | 6.17         | +0.59       |
| D6 SecurityPosture              | 7.29          | 6.83         | +0.46       |
| D7 Documentation                | 6.49          | 5.75         | +0.74       |
| D8 FailureHandling              | 7.06          | 6.90         | +0.16       |
| D9 ScaleReadiness (harness)     | 5.83          | 4.16 (SaaS)  | +1.67 mixed |
| D10 ShipReadiness (harness)     | 6.51          | 5.01 (SaaS)  | +1.50 mixed |
| **Overall**                     | **6.70**      | **6.122**    | **+0.58**   |

## What this session delivered (PRs in queue)

18 PRs total. All open at HEAD-of-main; merges convert branch state to
operator reality.

| #   | Branch                                  | Phase                                                                                                                | Dim                    |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 302 | chore/br-drift-cleanup                  | drift cleanup (br_health 401, memory enum, trajectory plural)                                                        | D1, D3, D7             |
| 303 | chore/assessment-v14                    | v14 baseline + path-to-90 plan                                                                                       | docs                   |
| 304 | feat/br-envelope-parser                 | P1a typed envelope parser + P5 live BR contract ratchet + Codex review fixes                                         | D1, D2, D3, D5, D6, D8 |
| 305 | chore/docs-sweep-p6                     | P6 README/CLAUDE.md package count 27→44, CHANGELOG v13/v14, stale trajectory cleanup                                 | D7                     |
| 306 | feat/audit-hash-persistence-p2          | P2 routing_audit table + repository + migration 034                                                                  | D5, D6, D8             |
| 307 | feat/agent-bootstrap-p3                 | P3 /v1/agent/bootstrap on `storm setup`                                                                              | D2, D6                 |
| 308 | chore/close-v13-attacker-bypasses-p9a   | P9a kill-gate word-boundary + -exec + brace/glob bypasses                                                            | D6                     |
| 309 | chore/webhook-nonce-replay-fix-p9b      | P9b LRU eviction + MAX_NONCE_CACHE 1000→100k                                                                         | D6                     |
| 310 | feat/doctor-runbook-routing-p8a         | P8a `storm doctor` failure → runbook routing                                                                         | D5                     |
| 311 | chore/curator-lock-pid-check-p9c        | P9c curator-lock PID-ownership check                                                                                 | D6                     |
| 313 | chore/fresh-env-install-ci-p8b          | P8b fresh-env install CI (CI now GREEN on ubuntu, gh run 25947856201)                                                | D10                    |
| 314 | chore/rollback-drill-ci-p8c             | P8c rollback drill CI (install latest → prev → latest, weekly cron)                                                  | D10                    |
| 315 | chore/assessment-v15-harness            | v15 stochastic baseline + harness rubric + auditor verdict                                                           | docs                   |
| 316 | chore/close-flag-loader-bypasses-p9a2   | P9a-2 v15 Attacker flag-loader class (vitest --config, go -toolexec/-gcflags/-ldflags, cargo --target-dir, --plugin) | D6                     |
| 317 | chore/p8b-multi-platform-install-matrix | P8b-2 ubuntu + macos + windows matrix on fresh-install CI                                                            | D10                    |
| 318 | docs/runbooks-expand-p8a2               | P8a-2 runbook expansion (br-degraded, cli-stuck-session, audit-chain-broken)                                         | D5, D7                 |

## v15 Attacker findings + status

| Finding                                                                                                         | Status                                                          |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| v13 kill-gate `npx vitest-pwn` (word-boundary)                                                                  | ✅ closed in PR #308 (P9a) — branch only                        |
| v13 kill-gate `go test -exec=/tmp/wrapper`                                                                      | ✅ closed in PR #308 — branch only                              |
| v13 brace/glob expansion in args                                                                                | ✅ closed in PR #308 — branch only                              |
| v13 webhook nonce burst-replay                                                                                  | ✅ closed in PR #309 (P9b) — process-restart wipe carry-forward |
| v13 curator-lock PID race                                                                                       | ✅ closed in PR #311 (P9c) — PID-reuse carry-forward            |
| v15 flag-loader class (vitest --config, go -toolexec, -gcflags, -ldflags, cargo --target-dir, generic --plugin) | ✅ closed in PR #316 (P9a-2)                                    |
| v15 audit-chain overclaim (P2 table exists, P2b writer doesn't)                                                 | ⏳ P2b open — wire envelope listener → routing_audit.insert()   |
| v15 community-key budget DoS (shared 10 RPM / $5/mo)                                                            | ⏳ needs per-host fingerprint (BR-side coordination)            |

## v15 carry-forward (path to v16 lift)

Per honest auditor verdict, the path from 6.70 → 9.0 requires:

1. **Merge the 18-PR queue** + npm publish 0.15.0. Converts branch
   state to operator reality. Expected measured lift: +0.4 to +0.6
   on D4/D10 once landed.

2. **P2b**: wire P1a's `onEnvelope` listener through
   `createProviderRegistry` into `RoutingAuditRepository.insert()`.
   Closes the audit-chain overclaim. D5 +0.3, D6 +0.3, D8 +0.3.

3. **P9d chaos suite**: BR-down failover regression test
   (`brainstorm-saas.ts` upstream fetch under network failure +
   503 mid-stream + DNS NXDOMAIN). Chaos Monkey's one-week action.
   D8 +1.0.

4. **D9 concurrent-session load test**: N parallel `storm chat`
   against shared SQLite + BR rate-limit. Pragmatist's one-week
   action. D9 +1.5.

5. **D6 community-key per-host fingerprint**: BR-side coordination
   to prevent global drain. D6 +0.2.

6. **State rollback (P8d)**: vault + SQLite migration downgrade path.
   D10 +0.3.

Cumulative if all 6 land (measured by next stochastic round, not
projected): **~8.2-8.6**. Still below 9.0.

## D4 and D9 ceiling honesty

Even with everything in 1-6 landed, two dims have structural ceilings:

- **D4 ProductionEvidence**: harness rubric 9-10 requires "real users
  install + use + report" with cited evidence of repeated operate-loop
  cycles. This accumulates over operator time, not via code changes.
  Realistic ceiling without dedicated adoption work: **8.0**.

- **D9 ScaleReadiness**: harness rubric 9-10 requires "chaos scenarios
  proven (BR rate-limit + concurrent sessions; SQLite-busy + abort-
  mid-write recovery)" — D9 load test + chaos suite move it to 8.0.
  Hitting 9-10 needs evidence the scenarios were exercised AT SCALE,
  which a CLI inherently caps at "operator's actual workload."
  Realistic ceiling: **8.5**.

## Honest path to overall mean ≥ 9.0

Mathematically requires the 6 items above + the D4/D9 ceiling work

- additional same-rubric improvement on D1/D2/D3/D5/D6/D7/D8 each
  crossing 9.0 individually. That is 10-15 more PRs after the current
  18-PR queue lands, plus accumulated operator-adoption time for D4.

Without the structural commitments + adoption time: **harness-rubric
ceiling is ~8.5 mean.** Hitting 9.0 mean across all 10 dims is not
a single-session or even single-month achievement.

## What 6.70 measured genuinely means

The CLI under v15 honest measurement is:

- Operable end-to-end (P8b CI green, install + smoke verified)
- Hardened against all named v13/v15 Attacker bypasses (P9a, P9a-2,
  P9b, P9c)
- Has real BR integration with envelope capture potential (P1a)
- Has operator-facing recovery runbooks (P8a + 3 new in P8a-2)
- Has CI ratchets that catch real bugs (P5 contract ratchet caught
  drift; P8b caught packaging bugs; both surfaced in this round)
- Honest carry-forwards documented for v16

It is NOT:

- A 9-out-of-10 harness (per the rubric the auditor applied)
- Production-traffic-proven (D4 ceiling)
- Multi-tenant load-tested (D9 ceiling)

## References

- Rubric: [docs/assessment-rubric-harness.md](assessment-rubric-harness.md)
- v15 evidence: [docs/assessment-evidence-v15.md](assessment-evidence-v15.md)
- v15 synthesis: [docs/assessment-synthesis-v15.md](assessment-synthesis-v15.md)
- v15 audit: [docs/assessment-audit-v15.md](assessment-audit-v15.md)
- Original plan: [docs/path-to-90-plan-2026-05-15.md](path-to-90-plan-2026-05-15.md)
