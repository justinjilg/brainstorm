# Stochastic Assessment Synthesis v13 — 2026-04-19

Previous: v12 scored 5.97/10 (σ 0.10). v13 measures commit window
f1a37b1…HEAD — 61 commits, all fix-class, zero new features.

## Overall Score: 6.10 / 10 (StdDev 0.047)

Delta from v12: **+0.13.** Range: 6.018 (Pessimist) to 6.208 (Sr Engineer).

StdDev at 0.047 is the tightest of the v9-v13 series
(0.12 → 0.10 → 0.047). Agreement widened: 9 of 10 agents landed
within a 0.11 band. **One outlier**: Sr Engineer at 6.208 (cited
regression-test-per-fix discipline verified by direct commit
inspection).

## 10-Agent Score Matrix

| Dimension             | Opt  | Pes  | Arc  | Aud  | Ops  | Att  | Com  | Pra  | SrE  | Cha  | Mean      | σ     | v12  | Δ     |
| --------------------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | --------- | ----- | ---- | ----- |
| Code Completeness     | 7.70 | 7.60 | 7.70 | 7.60 | 7.70 | 8.00 | 7.00 | 7.60 | 7.80 | 7.70 | **7.640** | 0.242 | 7.59 | +0.05 |
| Wiring                | 7.00 | 6.90 | 7.00 | 7.10 | 7.00 | 7.00 | 7.00 | 6.90 | 7.20 | 6.96 | **7.006** | 0.084 | 6.96 | +0.05 |
| Test Reality          | 6.90 | 6.80 | 6.80 | 6.90 | 6.90 | 7.00 | 7.00 | 6.85 | 7.00 | 7.10 | **6.925** | 0.093 | 6.74 | +0.19 |
| Production Evidence   | 4.78 | 4.78 | 4.78 | 4.78 | 4.78 | 5.00 | 5.00 | 4.78 | 4.78 | 4.78 | **4.824** | 0.088 | 4.78 | +0.04 |
| Operational Readiness | 6.10 | 5.90 | 6.10 | 6.00 | 6.30 | 6.00 | 6.00 | 6.05 | 6.10 | 6.00 | **6.055** | 0.101 | 5.80 | +0.26 |
| Security Posture      | 7.00 | 6.80 | 6.90 | 6.90 | 6.90 | 6.00 | 7.00 | 6.85 | 7.10 | 6.85 | **6.830** | 0.289 | 6.65 | +0.18 |
| Documentation         | 5.67 | 5.67 | 5.67 | 5.67 | 5.67 | 6.00 | 6.00 | 5.70 | 5.80 | 5.67 | **5.752** | 0.130 | 5.67 | +0.08 |
| Failure Handling      | 7.00 | 6.80 | 6.80 | 6.80 | 6.80 | 7.00 | 7.00 | 6.75 | 7.00 | 7.00 | **6.895** | 0.106 | 6.57 | +0.33 |
| Scale Readiness       | 4.10 | 4.05 | 4.20 | 4.30 | 4.20 | 4.00 | 4.00 | 4.15 | 4.30 | 4.30 | **4.160** | 0.114 | 4.05 | +0.11 |
| Ship Readiness        | 5.00 | 4.88 | 4.88 | 4.88 | 4.88 | 5.00 | 5.00 | 4.95 | 5.00 | 4.88 | **4.935** | 0.057 | 4.88 | +0.06 |

**Overall:** 6.102 (v12: 5.97, Δ **+0.13**).

## Monotonicity Check

All 10 dimension means are HIGHER than baseline. Invariant **holds**.

Per-agent overall scores vs v12 overall 5.97:

- Pes 6.02 (+0.05), Pra 6.06 (+0.09), Arc 6.08 (+0.11), Aud 6.09
  (+0.12), Att 6.10 (+0.13), Com 6.10 (+0.13), Ops 6.11 (+0.14),
  Cha 6.12 (+0.15), Opt 6.13 (+0.16), SrE 6.21 (+0.24).
- Zero agents below baseline. Monotonicity holds for every agent.

## Disagreement Hot-Spot

**Security Posture: σ 0.289 (highest of any dimension).** The
Attacker scored 6.00 (baseline 6.65, -0.65 regression) citing three
specific bypasses of new-in-v13 fixes:

1. `validateGateCommand("npx vitest-pwn")` returns `allowed: true` —
   prefix `"npx vitest"` has no word-boundary, so npm package
   typosquats bypass the kill-gate.
2. `validateGateCommand("go test -exec=/tmp/e ./...")` passes — the
   go toolchain runs the wrapper binary and the metachar filter
   doesn't catch `-exec=`.
3. Webhook HMAC has no timestamp binding; nonce cache is bounded to
   1000 entries, so churn lets captured payloads replay after
   eviction.

Every other agent (9/10) scored Security in 6.8–7.1 based on what
v13 fixed. The Attacker scored what v13 did NOT fix. **Both
perspectives are honest; disagreement IS the signal.** The
Attacker's -0.65 is cited with specific evidence, satisfies the
monotonicity carve-out, and is preserved in the final mean (6.830)
rather than clipped.

## Calibration Drift Corrections

**None applied.** Every score-down had a cited regression. Most
notable:

- **Competitor scored Code Completeness at 7.00 (baseline 7.59, -0.59)**
  citing orphan router plugin files as dead scaffolding. This is
  within-bucket (7-8 rubric level) but steep magnitude relative to
  the actual regression (2 orphan files vs 61 hardening commits).
  Other agents with the same evidence scored 7.60-8.00. **Not
  overridden** because the evidence is real, but flagged as the
  widest downside swing across agents.

## Risk Register (v13 consensus)

| Risk                                                      | Count     | Agents                              |
| --------------------------------------------------------- | --------- | ----------------------------------- |
| **Dep-cruiser RED on HEAD (2 orphan router files)**       | **10/10** | ALL — universal                     |
| F10 zero production telemetry                             | 4/10      | Arc, Aud, Pra, Ops                  |
| F5 shell string-trick bypass (sandbox acknowledged)       | 4/10      | Att, Pra, Arc, Cha                  |
| F3 busy_timeout synchronous TUI stall                     | 3/10      | Arc, Pra, Cha                       |
| Zero `*.e2e.test.ts` across 29 packages                   | 3/10      | Aud, Pra, Att                       |
| F8 ENOSPC + Docker daemon death traps                     | 3/10      | Pes, Arc, Pra (Cha says now closed) |
| F6 `/var/root/.ssh/` gap                                  | 3/10      | Att, Pra, Arc                       |
| **NEW: kill-gate bypass (npx vitest-X, go -exec, brace)** | 1/10      | Att (specific exploits enumerated)  |
| **NEW: webhook replay after nonce-cache eviction**        | 1/10      | Att (specific chain enumerated)     |
| NEW: curator lock ownership check (release without own)   | 1/10      | Att                                 |
| F1 env scrub `_KEY` gap                                   | 1/10      | Ops (Att says code now fixed it)    |
| F2 CI ratchet after `npm ci` in workflow order            | 0/10      | No agent re-flagged v13             |

## Verification Report (from Auditor + Sr Engineer)

Both agents spot-checked v13 fix commits independently. Results
match:

- **cc485b0** (classifier cache key): fix correct, test exercises
  the bug class. Grade A by both.
- **7acfc3d** (webhook sig before nonce): fix correct, test fires
  the exact UUID-guess attack vector. Grade A by both.
- **18e7a2d** (kill-gate metacharacter): fix correct for the
  enumerated 10-form attack sweep. Grade A by both — but Attacker
  then found 3 bypasses OUTSIDE the enumerated set.
- **c1bff5a** (ChangeSet GC): fix correct, test coverage adequate.
  Grade A by Auditor.
- **073884b** (InputHistory O(N²)): fix correct, test commits
  cross-restart persistence assertion. Grade A by Sr Engineer.

Zero discrepancies between commit claims and committed code across
5 verified fixes.

## Three-round trajectory

**v9 5.76 → v10 5.96 → v11 5.90 → v12 5.97 → v13 6.10**

Slope: +0.20, -0.06 (methodology rerun), +0.07, +0.13. v13 is the
largest gain since v10. Character shift: v12 was a targeted bypass
hunt that widened σ (0.10); v13 is broad hardening with tighter
agreement (σ 0.047).

## What this round produced

1. **Five bug classes closed systematically with tests**:
   $-backreference (5 sites), unbounded-growth (7 sites), regex
   word-boundary (2 sites), cache-key underspecification (1 site),
   TOCTOU lockfile (1 site).
2. **Two CI ratchets changed state**: F7 (`continue-on-error`)
   closed at 0/0 (was v12's top risk at 5/10); F9 (dep-cruiser)
   added but RED on HEAD.
3. **Four security gates moved**: webhook sig-before-nonce,
   pipeline dispatcher allowedTools enforcement, workflow kill-gate
   metacharacter rejection, memory runner O_EXCL TOCTOU.
4. **Seven test files gained regression coverage** paired with each
   v13 bug-hunt fix.

## What this round did NOT address

- F1 env scrub (Attacker says code is now broader than v12 regex
  suggested; Ops flagged it as still a gap — **unresolved
  disagreement**).
- F3 busy_timeout synchronous TUI stall (design-level; requires
  async driver).
- F5 shell string-trick bypass (sandbox comment still admits "not
  a capability sandbox").
- F6 `/var/root/.ssh/` (macOS root user home gap).
- F10 zero production telemetry (structural — local CLI, no
  hosted surface to observe).

## Agent-level narrative

| Agent        | Score | Key insight                                                    |
| ------------ | ----- | -------------------------------------------------------------- |
| Optimist     | 6.13  | Hardening round; F7 closed is the biggest Ops win              |
| Pessimist    | 6.02  | Orphans regress Wiring; 7 v12 findings unaddressed             |
| Architect    | 6.08  | F7 closed + F9 added in same round — net ratchet gain          |
| Auditor      | 6.09  | All 4 spot-checked commits match claims; ratchet is cosmetic   |
| Operator     | 6.11  | F7 closed at 0/0 is biggest Ops move; dep-cruiser RED caps     |
| Attacker     | 6.10  | Three NEW bypasses of v13 fixes + carried F5                   |
| Competitor   | 6.10  | Ahead of Aider/Continue; behind Claude Code on telemetry       |
| Pragmatist   | 6.06  | Maturity moved; dep-cruiser RED trains team to ignore ratchets |
| Sr Engineer  | 6.21  | 4/4 fix commits grade A; regression tests exercise bug class   |
| Chaos Monkey | 6.12  | ENOSPC + Docker traps NOW closed with tests; busy_timeout open |

Three agents came in HIGHER than the consensus mean (Opt 6.13, Cha
6.12, SrE 6.21); all three cited specific hardening evidence.
Three came in LOWER (Pes 6.02, Pra 6.06, Arc 6.08); all three cited
dep-cruiser RED or carried v12 findings.

## Recommended actions (pass 32+)

**Universal (10/10):** Resolve the RED dep-cruiser state.
`packages/router/src/strategies/{plugin-interface.ts,cost-first-plugin.ts}`
are untracked orphans committed as API surface with no consumers.
Either wire them with a real strategy and tests or delete them.
Leaving the new ratchet RED trains operators to ignore ratchets,
which erodes every other ratchet's value.

**Attacker-flagged (specific exploits):**

1. Tighten `ALLOWED_GATE_PREFIXES`: require word-boundary (trailing
   space) and deny `-exec=`, `-toolexec=`, `{`, `}` in addition to
   current metachar set.
2. Add timestamp binding + window enforcement to webhook HMAC so
   captured payloads can't replay after nonce-cache churn.
3. Add ownership check to curator lock release (check lock content
   pid before unlink).

**Design-level (carryover, require real work):**

- F3 busy_timeout async driver or UX downgrade.
- F5 shell string-trick — requires AST-parsed shell-quote.
- F10 telemetry — requires hosted egress path.

**Cleanup:**

- F6 `/var/root/.ssh/` add to sandbox patterns (one-line).
- F1 env scrub — verify whether Attacker's claim that code is already
  broader matches reality, and resolve the Ops-vs-Attacker disagreement.

## The payload is the finding list

At v13 the score differential (+0.13) is a directional signal. The
material output is the 10 findings consolidated above — 7 carried
forward from v12, 3 new-in-v13 (Attacker bypasses of this round's own
fixes). A ratchet that catches its own ring's orphans in the same
round that adds the ratchet is signal that the system is working.
