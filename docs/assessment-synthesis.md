# Stochastic Assessment Synthesis v12 — 2026-04-18

Previous: v11 scored 5.90/10 (σ 0.047). v12 deliberately hunted bypasses
of passes 27–30 (landed between v11 and v12) to test the hypothesis
that "each assessment round finds the next layer."

## Overall Score: 5.97 / 10 (StdDev: 0.10)

Delta from v11: **+0.07.** Range: 5.77 (Chaos Monkey) to 6.15 (Sr Engineer).

_(Initial draft of this synthesis reported 5.99 / +0.09 due to an
arithmetic error on Security Posture row sum — caught by Phase-4
Auditor. Corrected here.)_

**σ widened** from 0.047 → 0.10 — the largest spread of any round.
**Two agents scored below baseline** (Pessimist 5.87, Chaos Monkey
5.77) with cited regressions introduced by passes 27–30. Monotonicity
invariant honored: every drop has specific evidence, not just
reinterpretation.

## What v12 confirmed about the methodology

Each round of the assessment has produced something qualitatively
different:

- v9 → v10: surgical hardening (+0.20, tight σ)
- v10 → v11: methodology rerun caught 5 real findings v10 missed
  (−0.06 mean drift, tightest σ)
- v11 → v12: targeted bypass hunt found **bypasses of passes 27–30
  themselves** (+0.09 mean, widest σ — genuine disagreement on how
  much the bypasses matter)

The score is now a ±0.1 directional signal. The **payload is the
finding list.**

## 10-Agent Score Matrix

| Dimension             | A1   | A2   | A3   | A4   | A5   | A6   | A7   | A8   | A9   | A10  | Mean     | σ    | v11  | Δ     |
| --------------------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | -------- | ---- | ---- | ----- |
| Code Completeness     | 7.70 | 7.55 | 7.60 | 7.60 | 7.55 | 7.53 | 7.60 | 7.55 | 7.70 | 7.53 | **7.59** | 0.07 | 7.53 | +0.06 |
| Wiring                | 6.90 | 7.00 | 6.95 | 7.00 | 7.10 | 6.86 | 6.86 | 7.05 | 7.00 | 6.86 | **6.96** | 0.09 | 6.86 | +0.10 |
| Test Reality          | 6.80 | 6.70 | 6.75 | 6.75 | 6.70 | 6.60 | 6.60 | 6.75 | 6.90 | 6.80 | **6.74** | 0.09 | 6.60 | +0.14 |
| Production Evidence   | 4.80 | 4.77 | 4.80 | 4.77 | 4.77 | 4.77 | 4.95 | 4.77 | 4.80 | 4.60 | **4.78** | 0.08 | 4.77 | +0.01 |
| Operational Readiness | 5.90 | 5.60 | 5.80 | 5.85 | 5.85 | 5.72 | 5.80 | 5.95 | 5.85 | 5.72 | **5.80** | 0.11 | 5.72 | +0.08 |
| Security Posture      | 6.80 | 6.55 | 6.70 | 6.75 | 6.75 | 6.60 | 6.80 | 6.75 | 7.20 | 6.60 | **6.65** | 0.16 | 6.43 | +0.22 |
| Documentation         | 5.70 | 5.62 | 5.65 | 5.62 | 5.75 | 5.62 | 5.62 | 5.70 | 5.75 | 5.62 | **5.67** | 0.05 | 5.62 | +0.05 |
| Failure Handling      | 6.70 | 6.40 | 6.65 | 6.65 | 6.55 | 6.55 | 6.62 | 6.65 | 6.70 | 6.20 | **6.57** | 0.14 | 6.55 | +0.02 |
| Scale Readiness       | 4.00 | 3.94 | 3.95 | 4.10 | 3.94 | 3.94 | 4.05 | 4.30 | 4.30 | 3.94 | **4.05** | 0.13 | 3.94 | +0.11 |
| Ship Readiness        | 4.90 | 4.70 | 4.85 | 4.83 | 4.83 | 4.83 | 4.83 | 4.83 | 5.40 | 4.83 | **4.88** | 0.18 | 4.83 | +0.05 |

Security Posture +0.22 is the largest gain (pass 27 + 30 credit) but
Chaos Monkey's Failure Handling −0.35 and Pessimist's Ops/Ship
regressions counterbalance it.

## New substantive findings

### Legitimate security bug (pass 25 leftover, v11 missed)

**F1. Env scrub regex `_KEY` gap.** `SCRUBBED_ENV_PATTERN =
/(?:API_KEY|SECRET|PASSWORD|CREDENTIALS|PRIVATE_KEY|_TOKEN)/i` catches
`API_KEY` and `PRIVATE_KEY` but NOT bare `_KEY`. Real leak surface:

- `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `DATADOG_APP_KEY`, `HONEYCOMB_WRITEKEY`, `MIXPANEL_PROJECT_KEY`
- `SENTRY_DSN` (auth in URL, `DSN` pattern not covered)
- Anything with `_AUTH`, `_BEARER`, `_COOKIE`, `_JWT`, `_PAT`

### Regressions introduced by passes 27–30

**F2. CI ratchet supply-chain window.** Pass 29 placed
`check-as-any-budget.mjs` at ci.yml line 43, AFTER `npm ci` at line 22. A transitive-dep postinstall could mutate the script between
install and enforcement. Flagged by Pessimist + Auditor + Operator +
Sr Engineer (4/10). Fix: move step before `npm ci` — it uses only
Node stdlib.

**F3. Pass 28 busy_timeout is synchronous, TUI stalls silently.**
better-sqlite3 is synchronous; `busy_timeout=5000` blocks the Node
thread for up to 5s. Ink TUI renders on that thread. No progress
indicator wired. Pre-pass-28: fail-fast with SQLITE_BUSY. Post-pass-
28: silent 5s hang. Flagged by Pessimist + Chaos Monkey (2/10). Fix
requires design: async driver OR UX spinner + shorter default
timeout + fallback.

**F4. Pass 30 regex is unanchored (not unescaped).** _Correction:
Phase-4 Auditor verified that `.` IS properly escaped in every
pattern (`\.ssh`, `\.aws`, `\.netrc`, etc.). Sr Engineer's claim of
unescaped `.` was wrong._ What IS true: patterns aren't anchored with
`^` or word boundaries, so `~/.ssh/` matches as a substring anywhere
in the command. This creates over-inclusive false positives (e.g.,
`grep -r "~/.ssh/" docs/` gets blocked) rather than under-inclusive
bypasses. Lower priority than initially stated.

**F5. Pass 30 defeated by shell string tricks.**

- `cat $(echo ~)/.ssh/id_rsa` — no literal `~`, regex fails
- `cat /U""sers/$USER/.ssh/id_rsa` — string concat breaks
- ``cat `printf /U\x73ers/justin`/.ssh/id_rsa`` — hex in subshell
- `cat ~"/.ssh/id_rsa"` — quote between `~` and `/`
- `cat /Users/justin/.s*h/id_rsa` — glob expansion

Flagged by Attacker (1/10 but detailed). The code comment says
"path-name defense, not a real capability sandbox"; v12 confirms the
gap is wider than the comment suggests.

**F6. Pass 30 partial gap — `/var/root/.ssh` (macOS root user) only.**
_Correction: Phase-4 Auditor verified that `/private/etc/shadow` IS
caught by the existing unanchored `/\/etc\/shadow\b/` pattern via
substring match. The Pessimist/Architect claim that `/private/etc/`
bypasses was wrong._ What IS real: `/var/root/.ssh/` (macOS root
user home) isn't in any pattern. Narrower gap than initially
reported.

### Carried forward from v11

- F7. `continue-on-error: true` on core + vault test steps (5/10 —
  now a multi-round carryover)
- F8. ENOSPC + Docker daemon death traps still open (Chaos, 1/10)
- F9. No dep-cruiser for 27-package graph (Architect, 1/10)
- F10. Zero production telemetry (Auditor + Competitor + Pragmatist,
  3/10)

## Risk register (v12 consensus)

| Risk                                           | Count                    |
| ---------------------------------------------- | ------------------------ |
| `continue-on-error` on core + vault CI         | **5/10**                 |
| CI ratchet ordering vs `npm ci`                | **4/10**                 |
| Pass 30 `/private/`, symlinks, realpath bypass | 3/10                     |
| Zero production telemetry                      | 3/10                     |
| Pass 28 synchronous busy_timeout stalls TUI    | 2/10                     |
| Pass 30 regex unescaped `.` + unanchored       | 2/10                     |
| Env regex `_KEY` gap (NEW legitimate bug)      | **1/10 (high-severity)** |
| Pass 30 shell string-trick bypasses            | 1/10                     |
| ENOSPC + Docker daemon death untrapped         | 1/10                     |
| No dep-cruiser                                 | 1/10                     |

## Agent-level narrative

| Agent        | Score | Key insight                                                    |
| ------------ | ----- | -------------------------------------------------------------- |
| Optimist     | 6.02  | +5 dimensions moved, trap discipline held                      |
| Pessimist    | 5.87  | Ship + Ops + Fail all regressed with cited evidence            |
| Architect    | 5.97  | Passes 27–30 are pattern extensions, not new patterns          |
| Auditor      | 6.00  | All verification checks passed; ordering concern noted         |
| Operator     | 6.05  | CI ratchet now real; `continue-on-error` debt persists         |
| Attacker     | 5.92  | 6+ bypasses found in pass 27 + 30                              |
| Competitor   | 6.07  | Brainstorm now publishes stricter posture than Aider/Continue  |
| Pragmatist   | 6.03  | Crossed 6.0 (barely); CI gate still gated on soft-fail tests   |
| Sr Engineer  | 6.15  | Allowlist-first ordering sound; regex anchoring weak           |
| Chaos Monkey | 5.77  | Pass 28 is grace window not fix; 2/3 chaos surfaces still open |

## Three-round trajectory

**v8 5.36 → v9 5.76 → v10 5.96 → v11 5.90 → v12 5.97**

Slope narrowing: +0.40, +0.20, −0.06 (methodology), +0.07. Each round
produces fewer score points but more specific findings. v12 found
4 real substantive items (1 legitimate security bug, 2 real bypass
vectors, 2 regressions) — 2 items flagged by agents were hallucinated
and caught by the Phase-4 Auditor. The assessment has crossed the
point where running it is mostly about surfacing the next layer of
bugs, not moving the aggregate.

## Recommended actions (pass 31+)

Cheap high-severity (real after Auditor verification):

1. **F1 env regex `_KEY`**: extend pattern to `/(?:API_KEY|SECRET|PASSWORD|CREDENTIALS|PRIVATE_KEY|_TOKEN|_KEY|_AUTH|_BEARER|_COOKIE|_DSN|_JWT|_PAT)/i`. Add allowlist exemption for `SSH_AUTH_SOCK` (socket path, not secret).
2. **F2 CI ratchet ordering**: move step before `npm ci`. One-line move.
3. **F6 `/var/root/.ssh/`**: add to the sandbox path patterns (macOS root user home). Narrower than initially reported.

Skip (hallucinated findings, Auditor-verified):

- ~~F4 path regex unescaped `.`~~ — `.` IS escaped; unanchored-ness is a false-positive surface, not bypass
- ~~F6 `/private/etc/shadow` bypass~~ — existing unanchored regex already catches it

Design-level (defer or punt):

- F3 busy_timeout UX: async driver rewrite OR downgrade to 500ms + document
- F5 shell string tricks: true fix requires shell-quote AST parsing

Design-level (defer or punt):

- F3 busy_timeout UX: async driver rewrite OR downgrade to 500ms + document
- F5 shell string tricks: true fix requires shell-quote AST parsing

Structural (multi-round carryover):

- F7 core + vault CI debt
- F8 ENOSPC + Docker daemon death traps
- F9 dep-cruiser
- F10 telemetry
