# Stochastic Assessment Synthesis v16 — 2026-05-16

**Round:** v16 (post path-to-90 stack merge + v0.14.1 publish)
**Orchestrator:** Claude Code (this session)
**Protocol:** `/stochastic-assessment` skill, harness rubric
**Baseline:** v15 verdict 6.70 (`docs/assessment-audit-v15.md`)
**Evidence:** `docs/assessment-evidence-v16.md` (210 lines, fixed checklist)

## Phase 3 — mechanical synthesis

### Score matrix

| Agent       | D1  | D2  | D3  | D4  | D5  | D6  | D7  | D8  | D9  | D10 | Overall |
| ----------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ------- |
| Optimist    | 8.0 | 8.0 | 8.0 | 6.0 | 8.0 | 8.0 | 7.0 | 8.0 | 7.0 | 8.0 | 7.60    |
| Pessimist   | 7.0 | 7.0 | 6.0 | 5.0 | 6.0 | 7.0 | 6.0 | 6.0 | 6.0 | 6.0 | 6.20    |
| Architect   | 8.0 | 7.0 | 7.0 | 6.0 | 7.0 | 7.0 | 8.0 | 7.0 | 6.0 | 7.0 | 7.00    |
| Auditor     | 7.0 | 6.0 | 7.0 | 5.0 | 7.0 | 7.0 | 7.0 | 7.0 | 6.0 | 5.0 | 6.40    |
| Operator    | 8.0 | 8.0 | 7.0 | 7.0 | 7.0 | 7.0 | 7.0 | 7.0 | 7.0 | 7.0 | 7.20    |
| Attacker    | 8.0 | 7.0 | 7.0 | 5.0 | 7.0 | 6.0 | 7.0 | 8.0 | 6.0 | 8.0 | 6.90    |
| Competitor  | 7.6 | 7.2 | 7.4 | 6.5 | 8.0 | 7.6 | 6.8 | 7.2 | 7.0 | 7.5 | 7.28    |
| Pragmatist  | 8.0 | 6.0 | 7.0 | 6.0 | 7.0 | 7.0 | 7.0 | 7.0 | 7.0 | 7.0 | 6.90    |
| SrEngineer  | 8.0 | 7.0 | 7.0 | 6.0 | 7.0 | 7.0 | 7.0 | 7.0 | 6.0 | 8.0 | 7.00    |
| ChaosMonkey | 7.0 | 7.0 | 7.0 | 5.0 | 7.0 | 7.0 | 7.0 | 8.0 | 7.0 | 7.0 | 6.90    |

### Per-dimension stats

| Dim                      | Mean | Min | Max | Stddev | v15 Base | Delta     | Flag             |
| ------------------------ | ---- | --- | --- | ------ | -------- | --------- | ---------------- |
| D1 Code Completeness     | 7.66 | 7.0 | 8.0 | 0.47   | 7.60     | +0.06     | —                |
| D2 Wiring                | 7.02 | 6.0 | 8.0 | 0.67   | 7.00     | +0.02     | —                |
| D3 Test Reality          | 7.04 | 6.0 | 8.0 | 0.49   | 7.00     | +0.04     | —                |
| D4 Production Evidence   | 5.75 | 5.0 | 7.0 | 0.72   | 5.00     | **+0.75** | —                |
| D5 Operational Readiness | 7.10 | 6.0 | 8.0 | 0.57   | 7.00     | +0.10     | —                |
| D6 Security Posture      | 7.06 | 6.0 | 8.0 | 0.51   | 7.40     | **−0.34** | regression cited |
| D7 Documentation         | 6.98 | 6.0 | 8.0 | 0.48   | 6.80     | +0.18     | —                |
| D8 Failure Handling      | 7.22 | 6.0 | 8.0 | 0.63   | 7.00     | **+0.22** | —                |
| D9 Scale Readiness       | 6.50 | 6.0 | 7.0 | 0.53   | 6.00     | **+0.50** | —                |
| D10 Ship Readiness       | 7.05 | 5.0 | 8.0 | 0.96   | 7.50     | **−0.45** | regression cited |

**Grand mean: 6.94 (Δ +0.24 vs v15 baseline 6.70)**
**Per-agent overall stddev: 0.40** (tight consensus)
**Range: 6.20 (Pessimist) ↔ 7.60 (Optimist)**

### Calibration check

No dimension exceeds stddev 1.5 → no uncertain-flag.

Two dimensions dropped vs baseline (D6 -0.34, D10 -0.45). Per the monotonicity invariant, drops require cited regression. Both qualify:

- **D6 −0.34**: Attacker identified 3 new attack classes:
  1. BrainstormServer localhost confused-deputy (`packages/server/src/server.ts:112-122, 186-210`) — when `BRAINSTORM_JWT_SECRET` is unset and host is loopback, `/api/*` runs unauthenticated; any local process can hit `/api/v1/changesets/<id>/approve`, `/api/v1/memory`, `/api/v1/tools/execute`, `/api/v1/chat`.
  2. `make -f` kill-gate bypass — same flag-loader class that #308/#316 closed for `go test -exec` / `vitest --config` was missed for `make`, `pytest`, `cargo`, `npm test`.
  3. Platform-event replay (`packages/godmode/src/signing.ts:75-100`) — `verifyEvent` enforces timestamp window but has no `event.id` dedupe; signed events replayable for 5 minutes.

- **D10 −0.45**: Auditor + Pessimist + Competitor + Pragmatist independently flagged that v0.14.1 publish was incomplete — `@brainst0rm/{godmode, server, onboard, code-graph}` and ~15 others are not on the registry at 0.14.1. Cause: `.github/workflows/npm-publish.yml` uses a hardcoded for-loop list missing these packages. Combined with Rollback Drill workflow failing 3-for-3 on main (evidence §20), the release-train integrity is unverifiable.

No drift overrides applied — both drops are explicit, cited, and substantiated.

### Risk register (sorted by count)

| Risk                                                  | Count | Agents                                                                           |
| ----------------------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| Rollback Drill workflow failing on main               | 8/10  | Optimist, Pessimist, Operator, Architect, Pragmatist, Chaos, Auditor, Competitor |
| Incomplete v0.14.1 publish (4+ packages missing)      | 4/10  | Pessimist, Competitor, Pragmatist, Auditor                                       |
| Test failures presented as steady-state (turbo flake) | 4/10  | Pessimist, Pragmatist, SrEngineer, Auditor                                       |
| Release (Changesets) workflow failing on main         | 3/10  | Pessimist, Operator, Pragmatist                                                  |
| BrainstormServer localhost confused-deputy            | 1/10  | Attacker                                                                         |
| `make -f` kill-gate bypass class                      | 1/10  | Attacker                                                                         |
| Platform-event replay (no dedupe)                     | 1/10  | Attacker                                                                         |
| routing_audit retention / unbounded growth            | 1/10  | Architect                                                                        |
| Drift test TS-erasure hole                            | 1/10  | SrEngineer                                                                       |
| Edit-tool fs crash uncovered by chaos suite           | 1/10  | ChaosMonkey                                                                      |
| Untagged 0.14.0 still on npm                          | 1/10  | Pragmatist                                                                       |
| CLI god-object (27 internal deps)                     | 1/10  | Architect                                                                        |
| Worktree path 32-bit entropy in /tmp                  | 1/10  | Attacker                                                                         |

### Strengths (most-cited)

| Strength                                | Count | Notes                                                   |
| --------------------------------------- | ----- | ------------------------------------------------------- |
| P2b routing_audit wiring at chat boot   | 6/10  | Verified `packages/cli/src/bin/brainstorm.ts:7291-7305` |
| Agent-loop 5-branch chaos suite (P9d-2) | 5/10  | All branches asserted in `loop-chaos.test.ts`           |
| Multi-platform install matrix (P8b)     | 5/10  | ubuntu+macos+windows green                              |
| 24-PR Codex-reviewed merge flow         | 4/10  | Codex MAJOR findings closed before merge                |
| Downgrade guard error message quality   | 3/10  | `client.ts:127-144`                                     |
| Doctor → runbook routing live           | 2/10  | `storm doctor` actually prints `→ see ...`              |
| PID-ownership lock check                | 2/10  | `curator-runner.ts:156-189`                             |

### Synthesis paragraph

The grand mean of 6.94 (Δ +0.24 vs v15 baseline 6.70) reflects a real but bounded gain. Per-agent stddev of 0.40 indicates the 10 personas converged tightly despite their different lenses. The largest dimension gains are D4 (+0.75, npm publish + multi-platform install matrix), D9 (+0.50, concurrent-session load test with worker-thread parallelism), and D8 (+0.22, agent-loop chaos suite covering all 5 error classification branches). These gains correspond to landed-on-main artifacts the orchestrator can grep. Two dimensions regressed with cited evidence: D6 (-0.34) from the Attacker's identification of 3 new attack classes (server confused-deputy, make-f bypass, platform-event replay) — equivalent in shape to the v13/v15 Attacker findings that became #308/#316 fixes; D10 (-0.45) from the Auditor's discovery that the v0.14.1 publish was incomplete (4+ workspace packages not on the registry) compounded by Rollback Drill + Release workflows red on main. The recommended next action, cited by 8 of 10 agents, is fixing the release pipeline (Rollback Drill + complete v0.14.1 publish) before tagging anything further. Without that, every subsequent release inherits the same unverified path.

**Recommended next action**: Single-PR fix to `.github/workflows/npm-publish.yml` replacing the hardcoded for-loop with workspace-discovered publish, then cut v0.14.2 with all packages aligned, then verify Rollback Drill goes green. Closes the most-cited risk (8/10) in one move.
