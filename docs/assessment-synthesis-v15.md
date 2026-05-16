# Stochastic Assessment Synthesis v15 — 2026-05-15 (harness rubric)

**Rubric**: `docs/assessment-rubric-harness.md` (harness lens for D4/D9/D10).
**Evidence**: `docs/assessment-evidence-v15.md`.
**Baseline**: v14 auditor-corrected 6.122/10 (SaaS rubric).

## Honest Note On Profile Migration

v15 is a **profile migration**, not a simple round-over-round comparison.
v14 used the SaaS rubric for D4/D9/D10; v15 uses the harness rubric.
The shift is legitimate (brainstorm CLI is described in CLAUDE.md as a
"governed control plane for AI operators", i.e. a harness) but it means
v14 → v15 deltas on D4/D9/D10 mix profile change with PR work delivered.

## 10-Agent Score Matrix (raw means)

| Dim                       | Opt | Pes | Arc | Aud | Ops | Att | Com | Pra | SrE | Cha | Mean     | σ    |
| ------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | -------- | ---- |
| D1 CodeCompleteness       | 8.4 | 7.4 | 8.0 | 7.8 | 7.6 | 7.5 | 7.9 | 8.0 | 7.9 | 7.8 | **7.83** | 0.30 |
| D2 Wiring                 | 8.0 | 6.9 | 7.8 | 7.1 | 7.1 | 6.7 | 7.4 | 8.0 | 7.4 | 7.2 | **7.36** | 0.43 |
| D3 TestReality            | 8.1 | 6.7 | 7.6 | 7.0 | 7.0 | 7.2 | 7.5 | 8.0 | 7.6 | 7.1 | **7.38** | 0.46 |
| **D4 ProductionEvidence** | 7.8 | 5.8 | 6.5 | 5.5 | 5.4 | 4.9 | 7.8 | 8.0 | 7.3 | 6.5 | **6.55** | 1.10 |
| D5 OperationalReadiness   | 7.6 | 6.3 | 7.2 | 6.6 | 5.9 | 6.3 | 7.3 | 8.0 | 6.9 | 6.5 | **6.86** | 0.66 |
| D6 SecurityPosture        | 8.2 | 6.5 | 7.6 | 7.3 | 7.0 | 6.6 | 7.7 | 8.0 | 7.5 | 7.3 | **7.37** | 0.51 |
| D7 Documentation          | 7.2 | 5.9 | 7.0 | 6.0 | 5.4 | 6.0 | 6.7 | 8.0 | 6.5 | 6.2 | **6.49** | 0.72 |
| D8 FailureHandling        | 7.6 | 6.6 | 7.4 | 7.0 | 6.7 | 6.8 | 7.4 | 7.0 | 7.4 | 6.7 | **7.06** | 0.34 |
| **D9 ScaleReadiness**     | 6.8 | 5.2 | 6.3 | 5.5 | 5.2 | 5.4 | 6.5 | 7.0 | 6.5 | 4.9 | **5.93** | 0.71 |
| **D10 ShipReadiness**     | 7.4 | 5.7 | 6.8 | 5.8 | 5.4 | 5.8 | 7.0 | 9.0 | 7.5 | 6.2 | **6.66** | 1.07 |

## Overall Score: 6.95 / 10 (raw mean of 10 dim means)

Per-agent overall ranges: Pessimist 6.27 (low), Pragmatist 7.90 (high). σ across-agent overall: 0.59.

Bold means D4, D9, D10 are the harness-rubric-migrated dims. Their
v14 baselines (under SaaS rubric) were 4.82, 4.16, 5.01 — so the v15
harness numbers reflect both PR work AND instrument correction.

## Critical Cross-Agent Findings

### v15 surfaced TWO real CI failures fixed in real-time

1. **Run 25947002735** (post-PR #313 push) failed at "Build CLI + transitive
   deps" with `Could not resolve @brainst0rm/scheduler` + `@brainst0rm/onboard` —
   real packaging bug. Cli's `package.json` was missing two runtime workspace
   deps; workspace symlinks hid this locally.
2. **Run 25947493817** (after declaring those deps) failed at install with
   E404 — `@brainst0rm/archetype-msp@0.13.0` not on npm. Most workspace
   packages aren't published. Right structural answer: bundle workspace
   code into the CLI dist via tsup's `noExternal`.
3. **Run 25947704844** failed at npm ci (lockfile out of sync after dep
   changes).
4. **Run 25947758378** failed because workspace deps removed from package.json
   meant workspace symlinks didn't form. Right fix: list `@brainst0rm/*` as
   `devDependencies` so symlinks form but the tarball doesn't ship them.
5. **Run 25947856201** ✅ **GREEN** — end-to-end install + smoke passes.

This is the harness rubric working as designed. P8b's CI ratchet found a
real bug class (npm-publish vs workspace divergence) the SaaS rubric
wouldn't have surfaced. The fix is structural, not aspirational.

### NEW security findings (v15 Attacker)

The v13 bypass closures (P9a/P9b/P9c) hold against the specific strings
tested, but the Attacker found new bypasses in the same class:

- `npx vitest --config=/tmp/attacker.js` — vitest loads attacker JS at
  config import; `--config=`, `--reporter=` are unblocked
- `go test -toolexec=/tmp/x` — `-toolexec` runs an arbitrary wrapper;
  `-gcflags='all=-N -l ...'` similar
- These are kill-gate bypasses in the same "flag-loader" class as v13
  bypass #2. P9a's DANGER_PATTERNS only matches `/-exec/`; needs
  extension. Carry-forward to **P9a-2**.

### Audit-chain overclaim (v15 Attacker + Architect concur)

The evidence file says "P2 (audit chain persisted)" but no envelope-listener
wires `RoutingAuditRepository.insert()` to the SaaS provider's `onEnvelope`.
The table EXISTS; the writer doesn't. P2's commit body itself says "P2b will
wire" — but P2b doesn't exist yet. This is a real overclaim in the
evidence doc; the audit pipeline isn't complete until P2b lands.

### Community-key budget DoS (v15 Attacker, new finding)

The embedded `br_live_b028d7...` community key is rate-limited to 10 RPM
and $5/mo BUT the limit is SHARED across all anonymous users. A motivated
adversary can deny onboarding for the day with negligible cost. Real
finding; not in v14 risk register. Carry-forward.

### Doctor-runbook routing not on main (v15 Operator)

P8a's doctor → runbook routing is on branch but not in npm 0.14.0. End
users running today's published CLI still see exit-1 without recovery
hint. Operator persona's one-week-action remains the highest-leverage
operability fix; merge unblocks.

## Disagreement Hot-Spots

- **D4 σ 1.10** — Attacker 4.9 to Pragmatist 8.0. Disagreement on whether
  "install path verified live" suffices for the harness rubric's 9-10
  ("install + operate works reliably") given the unmerged-PR state.
- **D10 σ 1.07** — Operator 5.4 to Pragmatist 9.0. Same disagreement
  shape: P8b CI passes on this branch but isn't on main + npm 0.14.0
  is 42-day-stale.

The cross-agent split is real and resolvable: at HEAD-of-each-branch the
score IS higher (Pragmatist's reading); at HEAD-of-main + npm-published
it isn't (Operator/Pessimist/Attacker reading). v15 measures the former
per the synthesis rubric note; the gap closes when PRs merge.

## Per-agent overall scores (with delta vs v14 baselines)

| Agent            | v15 (harness) | v14 (SaaS) | Δ         |
| ---------------- | ------------- | ---------- | --------- |
| The Optimist     | 7.70          | 6.83       | +0.87     |
| The Pessimist    | 6.27          | 5.95       | +0.32     |
| The Architect    | 7.22          | 6.10       | +1.12     |
| The Auditor      | 6.56          | 5.30       | +1.26     |
| The Operator     | 6.16          | 6.13       | +0.03     |
| The Attacker     | 6.32          | 6.10       | +0.22     |
| The Competitor   | 7.32          | 5.80       | +1.52     |
| The Pragmatist   | 7.90          | 6.32       | +1.58     |
| The Senior Eng   | 7.25          | 6.35       | +0.90     |
| The Chaos Monkey | 6.64          | 6.13       | +0.51     |
| **Mean overall** | **6.95**      | **6.12**   | **+0.83** |

Discipline-lens (Opt, Ops, Pra, SrE, Cha) → +0.03 to +1.58 (Operator low
because deep main-vs-branch discipline).
Critical-lens (Pes, Aud, Att) → +0.22 to +1.26 (Auditor sharpest because
the harness-rubric reframe + branch evidence both lift, but caught real
overclaims).

## Mean: 6.95 — BELOW the 9.0 stopping condition

Per the hook condition "continue working until score ≥ 9.0", v15 does
not meet threshold. The honest analysis:

1. **PRs must merge before scores apply to operators.** 13 PRs in queue
   (302–311, 313, 314) all open at HEAD-of-main. Once merged, npm-published
   CLI gets the lift; until then it's branch-only evidence.
2. **NEW v15 findings raise the bar**: vitest --config flag-loader,
   go -toolexec bypass, community-key budget DoS, audit-chain wiring gap
   (P2b not yet done). Each is a real -0.2 to -0.4 on its dim if unfixed.
3. **D4 + D9 cannot mechanically reach 9.0 by per-PR work alone**:
   D4 requires real-traffic time (months of adoption), D9 requires
   load-tested concurrent CLI sessions which can be added but takes a
   dedicated PR.

## Path forward from v15

Ordered by leverage (largest single-PR lift first):

1. **Merge the 13-PR queue + npm publish 0.15.0** — converts the
   harness-rubric lift from branch state to operator-reality.
   Operator/Attacker/Pessimist downgrades reverse. Estimated mean
   lift: +0.4 to +0.6.
2. **P9a-2 flag-loader bypasses** — close vitest --config, go
   -toolexec, go -gcflags etc. Same regression-test-per-bypass
   discipline as P9a. D6 +0.3 to +0.5.
3. **P2b envelope listener → routing_audit** — wire the writer
   the v15 Auditor + Attacker both flagged. Closes the audit-chain
   overclaim. D6 +0.3, D5 +0.2.
4. **P9d chaos suite for BR-down** — BR upstream-down failover test,
   sandbox-death un-skipped, abort-mid-stream under load. Chaos Monkey's
   one-week action. D8 +1.0, D9 +0.5.
5. **D9 concurrent-session load test** — N parallel `storm chat` against
   shared SQLite with BR rate-limit interference. Pragmatist's
   one-week action (with P9d). D9 +1.5.

After items 1–5 land (probably 2–3 sessions of work): projected mean
~7.8–8.2. Still below 9.0; the remaining gap is structurally bounded
by D4 (production traffic requires real adoption over time).

## Calibration drift candidates (for auditor)

- **D4 Pragmatist 8.0** — under harness rubric reading. Cited evidence:
  "install path proven" + "envelope from live BR" + P8b + P8c. Defensible.
- **D10 Pragmatist 9.0** — same reading. Pre-this-commit, P8b CI was RED;
  post-this-commit it's GREEN on ubuntu-latest. The 9.0 only holds if
  the rubric reads "all four workflows green" inclusively — but multi-
  platform + state-rollback are still open. Auditor may rule this should
  be 7-8.
- **D6 Optimist 8.2** — claims all 3 v13 bypasses closed, but Attacker
  found new bypasses in the same class. v15 Attacker rates D6 at 6.6
  (lower than v14 6.83 baseline). The "fundamental bypass-class" failure
  v15 Attacker named is not yet refuted. Auditor likely rules toward
  Attacker.

## Files

- `docs/assessment-rubric-harness.md` — load-bearing rubric for v15+
- `docs/assessment-evidence-v15.md` — Phase 1 evidence
- `docs/assessment-synthesis-v15.md` — this file
- `docs/assessment-audit-v15.md` — Phase 4 auditor output (next)
- v15 baseline candidate: 6.95 (subject to auditor calibration)
