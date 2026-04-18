# Stochastic Assessment Synthesis v9 — 2026-04-18

Previous: v8 scored 5.36/10 on 2026-04-15 (3 days ago). This round covers
reliability passes 16–21 closing the Apr-2026 adversarial review (S1–S7).

## Overall Score: 5.76 / 10 (StdDev: 0.12)

Delta from v8: **+0.40 points.** Range: 5.65 (Attacker) to 6.04 (Architect).

Monotonicity invariant held: no dimension regressed. No UNCERTAIN
dimensions (all StdDev ≤ 0.30). No calibration drift corrections
required.

## 10-Agent Score Matrix

| Dimension             | A1  | A2  | A3  | A4  | A5  | A6  | A7  | A8  | A9  | A10 | Min | Max | Mean     | σ    | v8  | Δ     |
| --------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | -------- | ---- | --- | ----- |
| Code Completeness     | 7.5 | 7.4 | 7.8 | 7.4 | 7.4 | 7.4 | 7.4 | 7.4 | 7.5 | 7.4 | 7.4 | 7.8 | **7.46** | 0.13 | 7.2 | +0.26 |
| Wiring                | 6.8 | 6.6 | 7.2 | 6.8 | 6.8 | 6.7 | 6.6 | 6.8 | 7.0 | 6.7 | 6.6 | 7.2 | **6.80** | 0.18 | 6.4 | +0.40 |
| Test Reality          | 6.4 | 6.4 | 7.1 | 6.4 | 6.4 | 6.2 | 6.2 | 6.3 | 6.4 | 6.4 | 6.2 | 7.1 | **6.42** | 0.24 | 5.6 | +0.82 |
| Production Evidence   | 4.9 | 4.7 | 4.7 | 4.7 | 4.7 | 4.7 | 4.7 | 4.9 | 4.8 | 4.7 | 4.7 | 4.9 | **4.75** | 0.09 | 4.7 | +0.05 |
| Operational Readiness | 5.6 | 5.5 | 5.8 | 5.5 | 5.5 | 5.6 | 5.5 | 5.5 | 5.8 | 5.5 | 5.5 | 5.8 | **5.58** | 0.12 | 5.3 | +0.28 |
| Security Posture      | 5.9 | 5.9 | 5.9 | 5.9 | 5.9 | 5.9 | 5.9 | 5.9 | 6.2 | 5.9 | 5.9 | 6.2 | **5.93** | 0.09 | 5.9 | +0.03 |
| Documentation         | 5.5 | 5.4 | 5.7 | 5.7 | 5.5 | 5.3 | 5.5 | 5.5 | 5.8 | 5.4 | 5.3 | 5.8 | **5.53** | 0.15 | 5.2 | +0.33 |
| Failure Handling      | 6.2 | 6.6 | 6.9 | 6.3 | 6.3 | 6.1 | 6.0 | 6.1 | 6.8 | 6.3 | 6.0 | 6.9 | **6.36** | 0.30 | 5.2 | +1.16 |
| Scale Readiness       | 3.9 | 3.8 | 4.2 | 3.8 | 3.8 | 3.8 | 3.9 | 3.9 | 3.9 | 3.8 | 3.8 | 4.2 | **3.88** | 0.12 | 3.8 | +0.08 |
| Ship Readiness        | 4.7 | 4.5 | 5.1 | 4.6 | 4.7 | 4.8 | 4.6 | 4.8 | 4.9 | 4.7 | 4.5 | 5.1 | **4.74** | 0.17 | 4.3 | +0.44 |

## UNCERTAIN Dimensions (StdDev > 1.5)

None. All dimensions had StdDev ≤ 0.30 — the tightest cross-agent
agreement in any round of this assessment.

## Calibration Drift Corrections

None required. No agent scored a dimension below baseline without
citing regression evidence. Every score is HIGHER or SAME.

## Risk Register (sorted by agent consensus)

| Risk                                                                                  | Count | Agents                 |
| ------------------------------------------------------------------------------------- | ----- | ---------------------- |
| `as any` count regression (274 → 295 or 309, direction worse, measurement unverified) | 8/10  | 1, 2, 3, 4, 5, 7, 8, 9 |
| Uncommitted working tree (31 files, includes router plugin WIP + scanner dir)         | 7/10  | 1, 2, 4, 5, 8, 9, 10   |
| Scale / concurrency unvalidated (multi-window chat, WAL corruption, disk full)        | 3/10  | 2, 10, 3               |
| Parallel turbo test flake in core property test                                       | 2/10  | 1, 3                   |
| Inspection-only closures for S4/S6/S7 (timing bugs with no runnable trap)             | 1/10  | 10                     |
| Docker sandbox pseudo-isolation (no --network=none, --user, --cap-drop, bind-mount)   | 1/10  | 6                      |
| Env inheritance leaks OP_SERVICE_ACCOUNT_TOKEN to shell via process.env               | 1/10  | 6                      |
| Default `[shell] sandbox = "none"` + prompt injection → vault exfil                   | 1/10  | 6                      |
| No architectural boundary enforcement (no dependency-cruiser / import-linter)         | 1/10  | 3                      |
| Auto-updater trusts GitHub releases (supply chain)                                    | 1/10  | 6                      |
| Zero production telemetry / crash reporting                                           | 1/10  | 5                      |
| No jsdom+RTL harness (React hook coverage gap)                                        | 1/10  | 8                      |

## Agent Scores

| #   | Agent        | Overall | Key Finding                                                                    |
| --- | ------------ | ------- | ------------------------------------------------------------------------------ |
| 1   | Optimist     | 5.74    | Every dimension up or held; +0.38 without shortcuts                            |
| 2   | Pessimist    | 5.68    | Failure handling is the only axis that really moved                            |
| 3   | Architect    | 6.04    | Module boundaries held through 7 passes; need dependency-cruiser               |
| 4   | Auditor      | 5.71    | `as any` actually counted 309, not 295 — evidence undercounts                  |
| 5   | Operator     | 5.70    | AUDIT.md with citations is day-2-ops gold; stray scripts hurt first impression |
| 6   | Attacker     | 5.65    | Reliability ≠ security; sandbox defaults + Docker config are real gaps         |
| 7   | Competitor   | 5.73    | Adversarial-review methodology exceeds Aider/Continue.dev public posture       |
| 8   | Pragmatist   | 5.71    | Production-grade with prototype residue at the edges                           |
| 9   | Sr Engineer  | 5.91    | Comment density + ref patterns + bounded buffers — above-baseline code quality |
| 10  | Chaos Monkey | 5.68    | Real kills, not mocks — but WAL/ENOSPC/Docker-death untested                   |

## What Moved (evidence-backed)

- **Failure Handling +1.16** (5.2 → 6.36): five named commits closing
  S2/S4/S5/S6/S7, each with a runnable trap where behaviorally
  meaningful or inspection-gated where trap setup was disproportionate.
  Protocol-tier finalize-turn trap (7 cases), shell-abort background
  trap (2 new cases), pending-IPC reject pattern, SIGKILL fallback on
  quit, npx-fallback stdio wiring.
- **Test Reality +0.82** (5.6 → 6.42): protocol-tier grew 27→34
  tests; three-tier harness documented with AUDIT.md citation
  discipline.
- **Ship Readiness +0.44** (4.3 → 4.74): monorepo typecheck went from
  pre-existing failures to 0 errors; 29/29 builds cached; uncommitted
  files 70 → 31.
- **Wiring +0.40** (6.4 → 6.80): pass 17's pending-request reject and
  pass 21's npx-fallback stdio closed real wiring gaps.

## What Did Not Move (evidence-bounded)

- **Production Evidence** (4.7 → 4.75): structurally bounded — this is
  a local CLI/Desktop tool, not a deployed service. Cannot move
  without install telemetry, crash reporting, or synthetic probes.
- **Security Posture** (5.9 → 5.93): no new security work this round.
  Attacker flagged concrete gaps (sandbox defaults, env inheritance,
  Docker isolation) that did not exist in the v8 threat model because
  nobody was attacking them.
- **Scale Readiness** (3.8 → 3.88): single-user local tool; no
  multi-instance story by design.

## Most-Flagged Risk

`as any` count regression (8/10 agents). v8 baseline: 274. v9
evidence doc: 295. Auditor re-count: 309. Direction unambiguous;
magnitude disputed. The unresolved question is whether this is
measurement drift or real type-safety erosion during passes 16–21.

## Recommended One-Week Plan (cross-agent consensus)

1. **Audit the `as any` count** (8/10 agents): produce a categorized
   inventory, fix or justify each entry, commit a CI gate that fails
   if the count exceeds a committed baseline. This is the single
   metric that moved the wrong way.
2. **Clear the working tree** (7/10 agents): delete the 9 stray root
   scripts (`debounce.ts`, `pipe.ts`, etc.), either commit or branch
   the router plugin work-in-progress, handle the ephemeral
   directories (`tmp/`, `test-results/`) via `.gitignore`.
3. **Harden the Docker sandbox** (Attacker 1/10, but high-severity):
   add `--network=none`, `--user=1000:1000`, `--read-only` + tmpfs,
   `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
   `--memory=2g --pids-limit=256`; refuse full-workspace bind-mount;
   flip default `SandboxLevel` from `"none"` to `"restricted"`.
4. **Add fault-injection traps for corruption surfaces** (Chaos 1/10):
   truncated `-wal` at startup, `ENOSPC` mid-DB-write, Docker daemon
   death during sandbox execution.
5. **Architectural boundary enforcement** (Architect 1/10): install
   dependency-cruiser with a committed ruleset for the 27-package
   graph; wire into `turbo run check`.

## Delta from Baseline — Summary

**v8 5.36 → v9 5.76 (+0.40).** Nine of ten dimensions up, one held
(Security at +0.03 is within rounding). Largest mover is Failure
Handling (+1.16) — which is the correct shape for a 3-day reliability
sprint that closed 5 adversarial-review findings plus pass-16
typecheck cleanup.

This is the **smallest StdDev (0.12) of any round** — agents agree on
both direction and magnitude. That is the signal the monotonicity
invariant was designed to produce: when evidence is unambiguous,
agent disagreement collapses.
