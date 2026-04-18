# Stochastic Assessment Synthesis v10 — 2026-04-18

Previous: v9 scored 5.76/10 earlier the same day. v10 measures
whether passes 22–26 (as-any ratchet, working-tree cleanup, Docker
hardening, env scrub, WAL recovery trap — all landed after v9's
synthesis) moved the score and the risk register.

## Overall Score: 5.96 / 10 (StdDev: 0.07)

Delta from v9: **+0.20 points.** Range: 5.80 (Chaos Monkey) to 6.08 (Operator).

Monotonicity invariant held: no dimension regressed. No UNCERTAIN
dimensions (max σ = 0.42 for Security Posture, well under 1.5). No
calibration drift corrections required. Cross-agent agreement tightened
further (σ 0.12 → 0.07).

## 10-Agent Score Matrix

| Dimension             | A1   | A2  | A3   | A4   | A5   | A6  | A7   | A8   | A9   | A10  | Min  | Max  | Mean     | σ    | v9   | Δ         |
| --------------------- | ---- | --- | ---- | ---- | ---- | --- | ---- | ---- | ---- | ---- | ---- | ---- | -------- | ---- | ---- | --------- |
| Code Completeness     | 7.60 | 7.5 | 7.6  | 7.60 | 7.60 | 7.5 | 7.60 | 7.55 | 7.55 | 7.55 | 7.5  | 7.60 | **7.57** | 0.04 | 7.46 | +0.11     |
| Wiring                | 6.85 | 6.9 | 6.9  | 6.90 | 6.90 | 7.0 | 6.90 | 6.85 | 6.80 | 6.80 | 6.80 | 7.0  | **6.88** | 0.06 | 6.80 | +0.08     |
| Test Reality          | 6.65 | 6.6 | 6.6  | 6.65 | 6.65 | 6.4 | 6.70 | 6.55 | 6.80 | 6.60 | 6.4  | 6.80 | **6.62** | 0.11 | 6.42 | +0.20     |
| Production Evidence   | 4.80 | 4.8 | 4.75 | 4.75 | 4.75 | 4.8 | 4.75 | 4.85 | 4.75 | 4.75 | 4.75 | 4.85 | **4.78** | 0.04 | 4.75 | +0.02     |
| Operational Readiness | 5.75 | 5.8 | 5.75 | 5.75 | 6.00 | 5.7 | 5.80 | 5.75 | 5.75 | 5.58 | 5.58 | 6.00 | **5.76** | 0.10 | 5.58 | +0.18     |
| Security Posture      | 6.40 | 6.5 | 6.75 | 6.55 | 6.80 | 7.6 | 6.70 | 6.55 | 7.10 | 5.93 | 5.93 | 7.6  | **6.69** | 0.42 | 5.93 | **+0.76** |
| Documentation         | 5.60 | 5.7 | 5.6  | 5.55 | 6.20 | 5.6 | 5.55 | 5.55 | 5.80 | 5.60 | 5.55 | 6.20 | **5.68** | 0.19 | 5.53 | +0.15     |
| Failure Handling      | 6.65 | 6.6 | 6.7  | 6.60 | 6.70 | 6.5 | 6.70 | 6.55 | 6.80 | 6.55 | 6.5  | 6.80 | **6.64** | 0.09 | 6.36 | +0.28     |
| Scale Readiness       | 4.00 | 4.0 | 4.1  | 4.05 | 4.10 | 3.9 | 4.05 | 3.95 | 3.95 | 3.88 | 3.88 | 4.10 | **4.00** | 0.07 | 3.88 | +0.12     |
| Ship Readiness        | 4.95 | 5.2 | 5.1  | 4.95 | 5.10 | 5.0 | 4.85 | 4.95 | 5.10 | 4.78 | 4.78 | 5.2  | **5.00** | 0.12 | 4.74 | +0.26     |

## UNCERTAIN Dimensions (StdDev > 1.5)

None. Security Posture's 0.42 is the highest σ but well within tolerance —
the spread reflects Chaos Monkey scoring 5.93 (unchanged, security not in
scope for that perspective) vs Attacker's 7.60 (explicitly closed three
attack paths they flagged at v9).

## Calibration Drift Corrections

None required. No agent scored below baseline.

**Contradiction flagged by Phase-4 Auditor (not score-moving):** The
Attacker (Agent 6) Risk #3 claimed `"restricted"` mode runs host
children with `process.env` unchanged, because "line 86 short-circuits
scrubbing when level is `"none"` ... the container path is the only
one that scrubs." This is factually wrong: `shell.ts:85-95`
short-circuits ONLY when `level === "none"`; under `"restricted"` (the
default per line 106) the scrub loop runs, and both host spawn sites
(foreground line 374, background line 485) call `buildChildEnv(current
SandboxLevel)`. `shell-sandbox.test.ts:176-227` explicitly asserts
this. The Attacker simultaneously awarded Security Posture 7.60
(highest of any agent, crediting the scrub closure) AND flagged this
inconsistent risk — an internal contradiction. The 7.60 is kept in
the mean because the Auditor's recount with the Attacker's score
removed gives Security 6.54, still +0.61 over v9; the finding holds
either way. Flagged for v11 methodology: Phase-2 prompts should
include a "verify before you claim" requirement for any code-level
assertion.

## Risk Register (sorted by agent consensus)

| Risk                                                                | Count    | Agents            |
| ------------------------------------------------------------------- | -------- | ----------------- |
| Multi-window + disk-full scale scenarios still open                 | **6/10** | 2, 3, 4, 7, 9, 10 |
| Auto-updater GitHub supply-chain trust                              | **3/10** | 4, 6, 7           |
| Zero production telemetry                                           | **3/10** | 4, 7, 8           |
| Uncommitted WIP (router plugin, code-graph scanner)                 | **3/10** | 2, 4, 5           |
| ENOSPC mid-DB-write untrapped                                       | **2/10** | 2, 10             |
| Parallel turbo test flake unchanged                                 | **2/10** | 1, 9              |
| `sandbox=none` escape hatch can revert hardening                    | **2/10** | 2, 6              |
| CI ratchet not wired into `.github/workflows/*.yml`                 | 1/10     | 5 (Operator)      |
| Docker daemon death untrapped                                       | 1/10     | 10 (Chaos)        |
| No dependency-cruiser for 27-package graph                          | 1/10     | 3 (Architect)     |
| No jsdom+RTL harness (React hook coverage gap)                      | 1/10     | 8 (Pragmatist)    |
| S/A/C series naming glossary missing                                | 1/10     | 5 (Operator)      |
| GITHUB_TOKEN allowlist still enables gh-based exfil                 | 1/10     | 6 (Attacker)      |
| `buildChildEnv` scrub doesn't catch user-added unusual secret names | 1/10     | 9 (Sr Eng)        |
| Docker `--user=1000:1000` vs host UID mismatch                      | 1/10     | 9 (Sr Eng)        |

## Agent Scores

| #   | Agent        | Overall | Key finding                                                               |
| --- | ------------ | ------- | ------------------------------------------------------------------------- |
| 1   | Optimist     | 5.93    | All 8 dimensions up, 2 held; same-day movement trustworthy                |
| 2   | Pessimist    | 5.96    | Gains narrow; disk-full + multi-window still open                         |
| 3   | Architect    | 5.99    | CI ratchet pattern is structural win; extend to dep-cruiser               |
| 4   | Auditor      | 5.93    | All 5 verification checks passed; counts match, traps green               |
| 5   | Operator     | 6.08    | Highest score; but CI ratchet not actually wired in `.github/workflows/*` |
| 6   | Attacker     | 6.00    | 3 named v9 attack paths closed; Security Posture +1.67                    |
| 7   | Competitor   | 5.96    | 4 capabilities now technically exceed public posture of Aider/Continue    |
| 8   | Pragmatist   | 5.91    | Crossed "dressed-up prototype" → "early production-grade"                 |
| 9   | Sr Engineer  | 6.04    | `buildChildEnv` + WAL trap are reference-quality engineering              |
| 10  | Chaos Monkey | 5.80    | Lowest score; 1/3 corruption surfaces closed (WAL); 2/3 remain            |

## What Moved (evidence-backed)

- **Security Posture +0.76** (5.93 → 6.69): biggest single-dimension
  gain. Three v9 Attacker findings closed with traps:
  - A1 Docker hardening (6 flags: `--network=none`, `--user=1000:1000`,
    `--cap-drop=ALL`, `--security-opt=no-new-privileges`, memory/cpus/
    pids limits) + container UUID name.
  - A2 `buildChildEnv()` scrubs `OP_SERVICE_ACCOUNT_TOKEN`, every
    provider key, AWS creds, DB URLs — 20 explicit names + regex
    pattern. GITHUB_TOKEN allowlisted.
  - Default sandbox flipped `"none"` → `"restricted"`.
- **Failure Handling +0.28** (6.36 → 6.64): C1 SQLite WAL truncation
  recovery trap (`wal-recovery.test.ts`, 3 cases — zero-length,
  mid-frame, corrupt MAIN file).
- **Ship Readiness +0.26** (4.74 → 5.00): working tree 31 → 9,
  `as any` count 291 → 285, CI ratchet committed.
- **Test Reality +0.20** (6.42 → 6.62): +10 targeted trap tests
  (tools 96→103, db 30→33).

## What Did Not Move

- **Production Evidence +0.02** (4.75 → 4.78): structurally bounded,
  no telemetry stream.
- **Wiring +0.08** (6.80 → 6.88): no new subsystems required wiring.
- **Code Completeness +0.11** (7.46 → 7.57): small fix-pass volume.

## Most-Flagged Risk (v10)

**Multi-window + disk-full scale scenarios still open** (6/10 agents).
The v9 consensus on `as any` (8/10) and working tree (7/10) has been
supplanted by the chaos-monkey class of risks: WAL is closed but two
sibling scenarios remain untrapped. This is the natural shape for
round-over-round risk migration — close the loud risks, the next
round's loudest risk is the next layer down.

## Agent Agreement Analysis

σ dropped from v9's 0.12 to **0.07** — tightest agreement in any round.
Four possible causes:

1. Evidence is unambiguous (5 closed commits, each with a named trap)
2. Shared-evidence-doc anchoring (same critique v9's Auditor raised)
3. Same-day re-scoring effect (agents saw the delta clearly)
4. Monotonicity invariant working as designed

Likely a mix. The Attacker's 5.93 → 6.00 (lowest mover) and Operator's
5.70 → 6.08 (highest mover) track their personas: Attacker rewards
closed attack paths; Operator rewards operator-facing docs + runbooks.

## Recommended One-Week Plan (cross-agent consensus)

1. **Wire the as-any CI ratchet into `.github/workflows/ci.yml`** (1/10
   Operator, high-leverage): the gate exists but CI doesn't invoke it.
   Single-line fix. Without this, pass 22's ratchet is advisory, not
   enforced.
2. **Close the remaining 2/3 chaos-corruption traps** (6/10 consensus
   on scale): port the WAL test template to `enospc.test.ts` and
   `docker-daemon-death.test.ts`. Same filesystem-isolation pattern.
3. **Multi-window SQLite concurrency trap** (6/10 consensus): two
   Database handles on one path, interleaved writes, assert no
   `SQLITE_BUSY` escapes.
4. **Add dep-cruiser layer** (1/10 Architect): extends the pass-22
   ratchet pattern to the 27-package graph. Pre-empts 5-year rot.
5. **Opt-in telemetry beacon** (3/10 Auditor/Competitor/Pragmatist):
   first move toward lifting Production Evidence past the 4.78
   structural ceiling.

## Delta from Baseline — Summary

**v9 5.76 → v10 5.96 (+0.20).** Every dimension up or held. Largest
movers: Security Posture (+0.76), Failure Handling (+0.28), Ship
Readiness (+0.26). No dimension regressed.

Over two rounds: **v8 5.36 → v9 5.76 → v10 5.96.** +0.60 total across
the session. The slope is the signal — narrowing (+0.40, then +0.20)
suggests the highest-value fixes are behind us and the remaining
risks are structural (telemetry, supply chain) or infrastructure
(dep-cruiser, jsdom+RTL) rather than surgical.

## Methodology Notes

Same agent framework as v9. σ tightened further — 0.07 is the
lowest in any round. The Attacker was the lowest scorer at v9 (5.65)
and is now mid-pack at 6.00, reflecting that their v9 findings
translated into real commits with traps. The Chaos Monkey is now the
lowest (5.80), reflecting the unclosed chaos-corruption scenarios —
which is the correct signal for the persona, and the natural next
target.
