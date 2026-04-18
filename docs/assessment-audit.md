# v12 Calibration & Bias Audit — 2026-04-18

## Job 1: arithmetic audit

Summed each column of the 10-agent matrix directly.

| Dimension             | Computed          | Synthesis | Delta           |
| --------------------- | ----------------- | --------- | --------------- |
| Code Completeness     | 7.591 -> 7.59     | 7.59      | ok              |
| Wiring                | 6.958 -> 6.96     | 6.96      | ok              |
| Test Reality          | 6.735 -> 6.74     | 6.74      | ok              |
| Production Evidence   | 4.780 -> 4.78     | 4.78      | ok              |
| Operational Readiness | 5.804 -> 5.80     | 5.80      | ok              |
| **Security Posture**  | **6.650 -> 6.65** | **6.75**  | **+0.10 ERROR** |
| Documentation         | 5.665 -> 5.67     | 5.67      | ok              |
| Failure Handling      | 6.567 -> 6.57     | 6.57      | ok              |
| Scale Readiness       | 4.046 -> 4.05     | 4.05      | ok              |
| Ship Readiness        | 4.883 -> 4.88     | 4.88      | ok              |

Row: 6.80+6.55+6.70+6.75+6.75+6.60+6.80+6.75+7.20+6.60 = 66.50 -> mean
**6.65**. Synthesis prints 6.75. Delta v11 -> v12 should read
**+0.22**, not +0.32.

Propagating to overall: mean of the 10 corrected dimension means =
(7.59+6.96+6.74+4.78+5.80+**6.65**+5.67+6.57+4.05+4.88)/10 = 5.969 ->
**5.97**, not 5.99. v12 delta from v11 becomes **+0.07**, not +0.09.

Security Posture is load-bearing in the narrative ("+0.32 is the
largest gain"), so this single sum error propagates to the headline
overall and the trajectory slope. Only arithmetic error, but a
material one.

## Job 2: monotonicity audit

**Pessimist 5.87 (-0.03 vs v11 5.90).** Citations:

- CI ratchet ordering -> verified (npm ci at ci.yml:22, ratchet at
  ci.yml:43). Fair Ship penalty.
- busy_timeout synchronous TUI hang -> verified (better-sqlite3 is
  synchronous by design; Ink renders on the Node main thread). Fair
  Ops penalty.
- `/private/etc/` bypass -> **NOT verified**. The existing pattern
  `/\/etc\/shadow\b|\/etc\/sudoers\b/` is unanchored and matches
  `/private/etc/shadow` as substring. Pessimist wrong on this one.

2 of 3 citations land; -0.03 justified by F2 + F3 alone.

**Chaos Monkey 5.77 (-0.13 vs v11 5.90).** Citations:

- Pass 28 TUI stall as new user-visible failure mode -> verified.
- Pass 28 is a grace window, not a fix -> fair. Lock contention now
  degrades UX instead of producing a hard error.
- 2/3 chaos surfaces (ENOSPC, Docker daemon death) still open ->
  carryover, fair.

The -0.35 on Failure Handling is steep, but the rubric rewards fix
quality over closure count. Pass 28 is closure-without-fix. **Not a
rubric over-penalty.** -0.13 overall is internally consistent.

Monotonicity invariant **holds** for both sub-baseline scores.

## Job 3: verify the 6 new findings

**F1 (env scrub `_KEY` gap).** Regex
`/(?:API_KEY|SECRET|PASSWORD|CREDENTIALS|PRIVATE_KEY|_TOKEN)/i` at
shell.ts:71-72. `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`DATADOG_APP_KEY` contain none of those tokens. **REAL.**
High-severity legitimate bug.

**F2 (CI ratchet ordering).** Verified: `npm ci` at ci.yml:22,
`node scripts/check-as-any-budget.mjs` at ci.yml:43. Ratchet runs
after install. **REAL.**

**F3 (busy_timeout synchronous).** better-sqlite3 is synchronous by
design; the Node main thread blocks during prepare/run. Ink TUI
renders on that thread. **REAL architectural claim.**

**F4 (regex unescaped `.`).** Direct read of sandbox.ts:116-153.
Every `.` in path patterns IS escaped: `\.ssh\/`, `\.aws\/`,
`\.netrc`, `\.config\/`, `\.gnupg\/`, `\.docker\/config\.json`,
`\.npmrc`. **Dot-escape claim is FALSE.** The separate "not
end-anchored" observation is accurate but also intentional per the
code comment (substring matching across any tool). **Recommend
striking the dot claim; retain anchor note if framed as trade-off
not bug.**

**F5 (shell string tricks).** `checkRestricted` runs regex against
the raw command string with no AST/lex pre-processing. All cited
payloads (`$(echo ~)/.ssh/...`, `cat ~"/.ssh/..."`, glob expansion)
defeat literal match. **REAL** — and the code comment on line 112
("path-name defense, not a real capability sandbox") concedes it.

**F6 (`/private/etc/*` and `/var/root/.ssh`).** Pattern
`/\/etc\/shadow\b|\/etc\/sudoers\b/` is unanchored, so
`/private/etc/shadow` matches as substring. **`/private/etc/` claim
is FALSE — already covered.** `/var/root/.ssh/` IS a real gap; the
`.ssh` blocks hardcode `/Users/[^/]+` and `/home/[^/]+` with no
`/var/root` branch. **Partial: drop /private/etc, retain /var/root.**

Scorecard: **4 fully real (F1, F2, F3, F5), 1 false (F4 dot-escape
portion), 1 partial (F6).**

## Job 4: bias audit

Synthesis is not cherry-picked or softened. Pessimist and Chaos
Monkey keep sub-baseline scores with narrative support; "sigma
widened" is framed as honest disagreement, not drama. No agent is
treated unfairly.

Two concerns, both execution-level:

1. Security Posture's "+0.32 largest gain" line is rhetorically
   load-bearing; actual delta is +0.22.
2. Recommended-action #4 tells pass 31 to add `/private/etc/shadow|sudoers`
   patterns that the regex already catches. Actioning as written is
   make-work.

## Scores

- **Calibration: 6.5/10.** Security-row sum error propagates to the
  headline overall. Two of six new findings are wrong or partial (F4
  dot-escape, F6 /private/etc). These would mislead pass 31.
- **Honesty: 8/10.** No softening, no rhetorical inflation; errors
  are arithmetic + verification slips, not bias.

## Corrections required

1. Security Posture mean: 6.75 -> **6.65**. Delta v11 -> v12: +0.32
   -> **+0.22**.
2. Overall: 5.99 -> **5.97**. Delta v11 -> v12: +0.09 -> **+0.07**.
   Trajectory becomes 5.36 -> 5.76 -> 5.96 -> 5.90 -> **5.97**.
3. F4: strike the dot-escape claim; either drop entirely or reframe
   as "patterns intentionally substring-match and aren't end-anchored
   — acceptable trade-off per code comment."
4. F6: strike `/private/etc/shadow|sudoers`; retain `/var/root/.ssh`.
5. Recommended-action #4 (pass 31): drop the `/private/etc/` entry
   from the patch list. Keep `/var/root/.ssh/` only.
