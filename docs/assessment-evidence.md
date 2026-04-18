# Stochastic Assessment Evidence v12 — 2026-04-18 (same day as v9/v10/v11)

**v12 is targeted at hunting bypasses in passes 27–30** (landed after v11).
Passes 27-30 closed five v11 findings; the v12 panel's job is to prove
whether those fixes have their own bypasses, false-positives, or
regressions.

Prior rounds:

- v8 (pre-session): 5.36
- v9 (early session): 5.76
- v10 (after passes 22-26): 5.96
- v11 (methodology rerun, same code as v10): 5.90 — σ 0.047, surfaced 5 new findings

## Changes since v11 (passes 27–30)

All on `origin/main`. Commit `f1a37b1`.

Pass 27 — OP*SESSION*<accountid> scrub bypass fix:
packages/tools/src/builtin/shell.ts: added SCRUBBED*ENV_PREFIXES =
["OP_SESSION*", "AWS*", "GCP*", "AZURE*"]. Allowlist check runs
FIRST so GITHUB*\* still passes through. +3 trap cases in
shell-sandbox.test.ts.

Pass 28 — SQLite busy_timeout:
packages/db/src/client.ts: added `busy_timeout = 5000` pragma after
`journal_mode = WAL`. concurrent-writers.test.ts: 2 cases (pragma
verification + exhaustion path).

Pass 29 — CI ratchet wire-up:
.github/workflows/ci.yml: added `Lint — as-any escape-hatch budget`
step running `node scripts/check-as-any-budget.mjs`. Also flagged
existing `continue-on-error: true` on core + vault steps as TODO
debt (not fixed — root-cause investigation deferred).

Pass 30 — Sensitive-path read blocks:
packages/tools/src/builtin/sandbox.ts: added 9 path patterns to
BLOCKED_PATTERNS covering ~/.ssh/, ~/.aws/credentials, ~/.netrc,
~/.config/op/, ~/.gnupg/, ~/.docker/config.json, ~/.npmrc,
/etc/shadow, /etc/sudoers, /proc/\*/environ. 10 new trap cases.

Post-pass metrics:

- Tools tests: 116 (was 103 at v11)
- DB tests: 35 (was 33 at v11)
- AUDIT.md closed items: 25 (was 24 at v11)
- as-any budget: 285/285 (unchanged, no new casts)
- Typecheck: 0 errors
- `.github/workflows/ci.yml`: now invokes check-as-any-budget.mjs

## v12 scope (what agents should actively probe)

1. **Pass 27 bypass hunt**: can `_OP_SESSION_foo` (leading underscore),
   `OPsession_*` (case tricks), or `AWS` (no underscore suffix)
   escape the prefix match?
2. **Pass 28**: is 5000ms the right retry window, or will it hang a
   TUI under real lock contention?
3. **Pass 29**: is `node scripts/check-as-any-budget.mjs` placed
   BEFORE or AFTER `npm ci`? If after, a malicious postinstall could
   mutate the script. Also, does the existing `continue-on-error`
   debt mean CI green still doesn't mean passing tests?
4. **Pass 30 bypass hunt**: can an attacker read credentials via
   `/private/etc/...` (macOS), `$(echo ~)/..ssh/id_rsa`, symlinks,
   command-substitution tricks, `base64 < ~/.ssh/id_rsa` (the
   blocked patterns only match full paths, not redirect sigils)?
5. **False-positive regressions**: do the pass-30 path blocks break
   legitimate project files? (e.g., `packages/vault/docs/keys.md`,
   `docs/guides/aws-setup.md`, anything referencing `.ssh` in a
   project filename.)

Continue from v10 evidence below (unchanged sections omitted for
brevity; see git blame for full v10 content).

---

# [Archived: v10 evidence continues below]

Round 10 evidence. v9 was run earlier this session (baseline **5.76/10**,
σ 0.12). v10 measures whether passes 22–26 (all landed after v9's
synthesis) moved the risk register and the score.

Commands run at `/Users/justin/Projects/brainstorm`.

---

## 1. Recent commits (last 20)

```
9fbc324 test(db): SQLite WAL corruption recovery trap (C1, pass 26)
47aafc3 fix(tools): scrub secrets from shell child env (A2, pass 25)
f9c6625 fix(tools): Docker sandbox hardening + default-level flip (A1, pass 24)
c19b348 chore: clean working tree + gitignore persistent-leak patterns (pass 23)
338c014 chore: cap 'as any' escape hatches with CI ratchet (pass 22)
a597b20 fix(desktop): npx-fallback child gets full stdio wiring (S7)
0ee2d40 docs(desktop): audit — close S6, S5, S2, S4 review findings in passes 17–20
36bb8c7 fix(desktop): close send-guard race with ref (S4)
2e71e5f fix(tools): background shell tasks honor AbortSignal (S2)
9df4eff fix(desktop): partial replies flagged when backend error arrives mid-stream (S5)
6e9d181 fix(desktop): pending IPC requests reject on backend exit (S6)
f7b82fc fix: monorepo-wide typecheck + test cleanup (pass 16)
aded03d docs(desktop): AUDIT.md — rename 'Open items' to 'Closed during passes 10–15'
8a6d171 docs(desktop): audit — close the final four items, mark reliability plan complete
5882ad1 test(desktop): pass 14 — fork/handoff IPC contract pinned down
4cde98a docs(desktop): tests-live README — trim stale pass-6 candidate list
50eedb1 docs(desktop): tests-live README — add shell AbortSignal + orphan-on-quit bugs to the caught list
dacf1b5 fix(desktop): SIGKILL fallback on before-quit prevents orphan ipc children
2d27c3c docs(desktop): audit — close 3 open items from passes 10/11/12
fcda9cc feat(core): config.agent.streamTimeoutMs makes the stall watchdog configurable
```

All 9 post-v9 passes pushed to `origin/main`.

## 2. Build status

```
Tasks:    29 successful, 29 total
Cached:    8 cached, 29 total
  Time:    13.019s
```

All 29 packages build. Fewer cache hits than v9 (28/29) because
passes 22–26 touched tools, db, and cli packages — invalidations
worked correctly.

## 3. Typecheck status

Per-package `tsc --noEmit`:

- `packages/core`: 0 errors (verified this round)
- `packages/tools`: 0 errors (verified this round, post pass-25)
- `packages/router`: 0 errors
- `packages/vault`: 0 errors
- `packages/server`: 0 errors
- `packages/gateway`: 0 errors
- `apps/desktop`: 0 errors
- `packages/cli`: 0 errors (verified this round, post pass-22 import additions)
- `packages/db`: 0 errors (post pass-26 new test file)

## 4. Test summary (per-package, individual runs)

| Package                   | v9 tests | v10 tests | Delta                |
| ------------------------- | -------- | --------- | -------------------- |
| `@brainst0rm/tools`       | 96       | 103       | +7 (env scrub cases) |
| `@brainst0rm/db`          | 30       | 33        | +3 (WAL recovery)    |
| `@brainst0rm/cli`         | 187      | 187       | same                 |
| `@brainst0rm/core`        | 410      | 410       | same                 |
| `@brainst0rm/vault`       | 56       | 56        | same                 |
| `@brainst0rm/eval`        | 41       | 41        | same                 |
| `@brainst0rm/server`      | 25       | 25        | same                 |
| `@brainst0rm/workflow`    | 43       | 43        | same                 |
| `@brainst0rm/ingest`      | 21       | 21        | same                 |
| Desktop protocol          | 34       | 34        | same                 |
| Desktop mocked Playwright | 79       | 79        | same                 |

Individual per-package runs all green. Parallel turbo full-suite
run: same flake pattern as v9 (core property test races under
resource contention; unchanged by passes 22–26).

## 5. Live-harness / E2E

Unchanged from v9:

- 4 protocol spec files, 34 tests
- 13 live Electron spec files
- 5 incident repro traps

## 6-11. HTTP / gateway health

N/A — this is the Brainstorm CLI + Desktop monorepo, not
BrainstormRouter. Substitute evidence (pass-22 CI ratchet,
pass-24 sandbox hardening, pass-25 env scrub, pass-26 WAL trap)
documented in passes below.

## 12-13. Test file counts

```
Total test+spec files: 157  (v9: 155, +2)
Desktop protocol tier: 4
Desktop flow tier (live): 13
Desktop repro tier: 5
Total E2E/integration: 22  (unchanged)
```

Test file additions since v9:

- `packages/tools/src/__tests__/shell-sandbox.test.ts` gained the "shell
  tool default sandbox level" describe + "buildChildEnv" describe
- `packages/db/src/__tests__/wal-recovery.test.ts` (new, 3 cases)

## 14-15. Source / test line ratio

Not re-counted this round (delta is small: ~170 lines of added
test code in tools + db, ~150 lines of production code for
scrubbing and sandbox flags). v9 was 32.8%. v10 is still in the
same neighborhood.

## 16. Type errors

0 errors, same as v9.

## 17. Wiring audit

49 production entrypoint references (unchanged from v9). Pass 21
closed the last dangling wiring gap (npx-fallback stdio); passes
22–26 did not add new subsystems requiring new wiring.

## 18. Timer / interval usage

11 in `packages/core/src` (unchanged — no passes touched that
surface).

## 19-20. Uptime / active tasks

N/A — local CLI.

## 21. `as any` count

```
grep -rn "as any" packages/ apps/ --include="*.ts" --include="*.tsx" \
  --exclude-dir=node_modules --exclude-dir=dist | \
  grep -v "\.test\." | grep -v "\.spec\."  →  285
```

Same filter as v9. Pre-pass-22 was 291 (with 6 gratuitous Zod-enum
casts); pass 22 dropped it to 285. Passes 23–26 did not add any
new `as any`. CI ratchet (`scripts/check-as-any-budget.mjs`) fails
if count exceeds 285.

v8 → v9 (three days): 274 → 291 (+17, drift direction worse).
v9 → v10 (same day): 291 → 285 (–6, direction reversed).

## 22. Uncommitted files

```
9 entries in `git status --short`
```

Down from 31 at v9. Breakdown:

- 2 in-progress router strategy files (`cost-first-plugin.ts`,
  `plugin-interface.ts`) — WIP feature work, owner knowledge required
- 1 in-progress code-graph scanner directory
- 3 eval-data SWE-bench jsonl fixtures (may be intentional additions)
- 1 docs/kairos-runs/03-codebase-audit (WIP run output)
- 1 scripts/generate-arch-diagram.js (utility script, not yet committed)

Zero stray-script throwaways, zero tsup bundle artifacts, zero
release/test-results noise. The remaining 9 are all legitimate
items that need owner context to classify. **57% reduction from
v9 (31 → 13 → 9).**

## 23. AUDIT.md status

```
apps/desktop/tests-live/AUDIT.md:
  24 ✅ closed items across reliability passes 3–26
```

Up from 21 closed at v9 (+3 items: A1 Docker hardening, A2 env
scrubbing, C1 WAL recovery).

## 24. Reliability passes since v9 synthesis

| Pass | Finding                                           | Commit  | Trap                                        |
| ---- | ------------------------------------------------- | ------- | ------------------------------------------- |
| 22   | `as any` regression (8/10 v9 consensus)           | 338c014 | `scripts/check-as-any-budget.mjs` (ratchet) |
| 23   | Uncommitted working tree (7/10 v9)                | c19b348 | inspection (`.gitignore` + deletion)        |
| 24   | A1 Docker sandbox hardening + default-level flip  | f9c6625 | `shell-sandbox.test.ts` restricted-default  |
| 25   | A2 shell env scrubs OP_SERVICE_ACCOUNT_TOKEN etc. | 47aafc3 | `shell-sandbox.test.ts` 6 env cases         |
| 26   | C1 SQLite WAL truncation recovery                 | 9fbc324 | `wal-recovery.test.ts` 3 cases              |

## 25. Remaining open risks (from v9 register)

| Risk                                             | v9 agents | v10 status                     |
| ------------------------------------------------ | --------- | ------------------------------ |
| `as any` drift                                   | 8/10      | ✅ capped + ratcheted          |
| Uncommitted tree                                 | 7/10      | ✅ 31 → 9                      |
| Scale/concurrency (multi-window, WAL, disk full) | 3/10      | ⚠️ 1/3 (WAL) trapped, 2/3 open |
| Parallel turbo test flake                        | 2/10      | ⚠️ unchanged                   |
| Inspection-only S4/S6/S7 closures                | 1/10      | ⚠️ unchanged                   |
| Docker sandbox pseudo-isolation                  | 1/10      | ✅ 6 hardening flags added     |
| Env inheritance (OP_TOKEN leak)                  | 1/10      | ✅ scrubbed                    |
| Default `sandbox=none` + prompt injection        | 1/10      | ✅ flipped to restricted       |
| No dep-cruiser                                   | 1/10      | ⚠️ unchanged                   |
| Auto-updater GitHub trust                        | 1/10      | ⚠️ unchanged                   |
| Zero production telemetry                        | 1/10      | ⚠️ structural                  |
| No jsdom+RTL                                     | 1/10      | ⚠️ unchanged                   |

## 26. Delta summary (v9 → v10)

| Metric                  | v9    | v10   | Direction     |
| ----------------------- | ----- | ----- | ------------- |
| AUDIT.md closed         | 21    | 24    | +3            |
| Reliability passes      | 21    | 26    | +5            |
| `as any` (fixed filter) | 291   | 285   | -6 (reversed) |
| Uncommitted files       | 31    | 9     | -22           |
| Desktop protocol tests  | 34    | 34    | =             |
| Tools tests             | 96    | 103   | +7            |
| DB tests                | 30    | 33    | +3            |
| Typecheck errors        | 0     | 0     | =             |
| Build (packages green)  | 29/29 | 29/29 | =             |

All deltas are in the right direction or hold. No regressions.
Passes 22–26 each target a specific risk from the v9 register.
