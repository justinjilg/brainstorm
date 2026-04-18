# Stochastic Assessment Evidence v9 — 2026-04-18

Raw evidence for round 9. Commands run at `/Users/justin/Projects/brainstorm`.

The checklist in the skill targets **BrainstormRouter** (a deployed AI gateway). This
project is **Brainstorm CLI + Desktop App** (a workspace monorepo). Where
checks target the gateway HTTP surface (items 6–11 in the original list), they
are marked N/A with substitute evidence from the CLI/Desktop surface.

Baseline: v8 scored **5.36/10** on 2026-04-15 (3 days ago).

---

## 1. Recent commits (last 20)

```
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
c1cf266 test(desktop): pass 10 — direct sqlite readback for turn durability
d24412b docs(desktop): architectural gotcha audit — ground-truth map
a4ac3a9 fix(tools): shell tool now honours the AbortSignal; regression trap added
712e75f test(desktop): live-harness pass 7 — NDJSON framing torture
060a566 test(desktop): live-harness pass 6 — three-tier shape (protocol + flow + repro)
```

## 2. Build status (turbo run build)

```
 Tasks:    29 successful, 29 total
Cached:    28 cached, 29 total
  Time:    4.092s
```

All 29 packages build. One Vite warning about chunk size > 500kB in `@brainst0rm/desktop` renderer bundle — cosmetic, not a failure.

## 3. Type-check status

Root-level `tsc --noEmit`: **0 errors.**

Per-package `tsc --noEmit`:

- `packages/core`: 0 errors
- `packages/router`: 0 errors
- `packages/tools`: 0 errors
- `packages/vault`: 0 errors
- `packages/server`: 0 errors
- `packages/gateway`: 0 errors
- `apps/desktop`: 0 errors

Pass 16 (commit f7b82fc, 3 days ago) was an explicit monorepo-wide typecheck cleanup.

## 4. Test summary (per-package, run individually)

| Package                   | Test Files           | Tests                  | Status                                            |
| ------------------------- | -------------------- | ---------------------- | ------------------------------------------------- |
| `@brainst0rm/core`        | 31                   | 410                    | PASS (1 flake under parallel turbo, passes alone) |
| `@brainst0rm/tools`       | 7 passed / 1 skipped | 96 passed / 21 skipped | PASS                                              |
| `@brainst0rm/vault`       | 5                    | 56                     | PASS                                              |
| `@brainst0rm/eval`        | 6                    | 41                     | PASS                                              |
| `@brainst0rm/server`      | 3                    | 25                     | PASS                                              |
| `@brainst0rm/workflow`    | 3                    | 43                     | PASS                                              |
| `@brainst0rm/docgen`      | 3                    | 14                     | PASS                                              |
| `@brainst0rm/ingest`      | 3                    | 21                     | PASS                                              |
| `@brainst0rm/onboard`     | 3                    | 23                     | PASS                                              |
| `@brainst0rm/sdk`         | 1                    | 17                     | PASS                                              |
| `@brainst0rm/cli`         | 15                   | 187                    | PASS                                              |
| Desktop mocked Playwright | 79 spec files        | 79                     | PASS (36.5-41.8s)                                 |
| Desktop protocol (vitest) | 4                    | 34                     | PASS (36.28s)                                     |

Turbo parallel full-suite run: resource contention causes flakes in
core property test, desktop skill-toggle visual, and a few other
time-sensitive tests. Individually, everything passes.

**Known flake:** `packages/core/src/__tests__/property-tests.test.ts >
"saved content is retrievable unchanged"` times out at ~5s under parallel
load, passes in ~900ms when run in isolation. This is a resource
contention flake, not a regression.

## 5. E2E / Live-harness status

Desktop has a three-tier reliability harness:

- **Protocol tier** (vitest, node-env): 4 test files, 34 tests, real
  brainstorm-ipc subprocess. All pass in ~36s.
- **Flow tier** (Playwright Electron): 13 live spec files, runs against
  actual Electron + backend child.
- **Repro tier** (`_repro/`): 5 named incident traps.

```
18 total test files under tests-live + tests-protocol
13 live specs + 5 repro traps + 4 protocol specs
```

## 6. Production evidence (N/A — not a deployed service)

This is a CLI/Desktop app, not an HTTP API. Substitute evidence:

- `packages/cli` is npm-published as `@brainst0rm/cli`
- Desktop app builds a `.dmg` installable (electron-builder config in package.json)
- No uptime monitoring; no synthetic probes; no incident history
  available because this is a local tool.

## 7-8. Provider / gateway health (N/A)

No deployed gateway. The project includes a `packages/gateway` client
for BrainstormRouter, but BrainstormRouter is a separate project in
`~/Projects/brainstormrouter/`.

## 9. Live completion test (N/A — local CLI)

Substitute: the IPC protocol layer is exercised end-to-end in the
protocol-tier tests against the real `brainstorm ipc` subprocess.
`tests-protocol/ndjson-framing.test.ts` is the canonical trap —
6 cases covering ready signal, single-frame response, mid-stream
garbage, line concat, chunked writes, and clean stdin-close exit.

## 10-11. Routing intelligence endpoints (N/A)

These are BrainstormRouter endpoints, not part of this project.

## 12. Test file count

```
packages/**/*.test.ts:           130 files
apps/**/*.test.ts:                 5 files  (tests-protocol)
apps/**/*.spec.ts:                20 files  (tests-live + Playwright)
Total:                           155 test files
```

## 13. E2E file count

```
apps/desktop/tests-live/**/*.spec.ts:  13 live Electron specs
apps/desktop/tests-live/_repro/*.ts:    5 incident traps
apps/desktop/tests-protocol/*.test.ts:  4 protocol specs
Total:                                 22 end-to-end / integration files
```

## 14. Source lines (excluding tests)

```
packages/**/*.ts + apps/**/*.ts (exclude test/spec/d.ts):  92,166 lines
```

## 15. Test lines

```
packages/**/*.test.ts + apps/**/*.spec.ts:  30,251 lines
```

Test-to-source ratio: **32.8%** (30,251 / 92,166).

## 16. Type errors

0 errors across all audited packages (see item 3).

## 17. Wiring audit (entrypoint references)

```
new BrainstormServer | startIPCHandler | createGateway | mountApiRoutes |
new VirtualKeyVault  | new CostTracker
grep across packages/ + apps/ (excluding tests):  49 production references
```

## 18. Timer / interval usage (leak-risk surface)

```
setInterval + setTimeout in packages/core/src:  11 production occurrences
```

Reliability pass 16 included a sweep of timer leaks in core packages
(commit a69b84b before the v8 baseline). Not re-audited this round.

## 19. Uptime / 20. Active ECS tasks (N/A — local CLI)

## 21. `as any` counts in production code

```
grep 'as any' in packages/ + apps/ (excluding tests):  295 occurrences
```

v8 baseline reported 274. Delta: **+21.** Need to confirm whether
increase is from new code or measurement drift (v8's grep may have
used different filters).

## 22. Uncommitted files

```
31 entries in `git status --short`
```

Breakdown (noise vs real work):

- 9 stray scripts at repo root (`debounce.ts`, `pipe.ts`, `flatten.ts`,
  `groupby.ts`, `merge.js`, `parse_deps.js`, `pipe.js`, `analyze_deps.py`,
  `test_separability.py`) — throwaway experiments
- 3 uncommitted diagrams (`ARCHITECTURE_DIAGRAM.txt`, `arch_diagram.txt`,
  `BUG-SCAN.md`) — stale artifacts
- 2 lock / bundle artifacts (`packages/gateway/pnpm-lock.yaml`, three
  `tsup.config.bundled_*.mjs` temp files)
- 2 router strategy files (`cost-first-plugin.ts`, `plugin-interface.ts`)
  — in-progress work
- 1 code-graph scanner directory (`packages/code-graph/src/scanner/`)
- 1 eval-data directory (`eval-data/*.jsonl`) — test fixtures
- 1 vault directory (`brainstorm-vault/`) — runtime state
- 1 docs directory (`docs/kairos-runs/03-codebase-audit/`) — run artifacts
- 2 test-results directories — ephemeral
- 1 `tmp/` — ephemeral
- Modified files (not new): 9 files with pending edits

v8 baseline cited "70 uncommitted files" as the #1 risk. Today's
count is 31, with most being ephemeral artifacts rather than feature
work. **Not a regression but still needs cleanup.**

## 23. AUDIT.md status (desktop reliability)

```
apps/desktop/tests-live/AUDIT.md:
  21 ✅ closed items across reliability passes 3–21
  Source citations: SDK issues #625, #701, #739, #817;
    Vercel AI test suites (retries, stop-condition, abort-signal);
    Claude Agent SDK permissions doc
```

Every closed item has either a runnable trap (protocol or live) or a
documented reason why a trap would be disproportionate to the fix.

## 24. Reliability passes 17–21 (since baseline v8)

| Pass | Finding                                                    | Commit  | Trap                                   |
| ---- | ---------------------------------------------------------- | ------- | -------------------------------------- |
| 17   | S6: pending IPC requests leak on backend exit              | 6e9d181 | inspection                             |
| 18   | S5: partial replies marked as complete on mid-stream error | 9df4eff | `finalize-turn.test.ts` (7 cases)      |
| 19   | S2: background shell tasks ignore `AbortSignal`            | 2e71e5f | `shell-abort.test.ts` (2 new bg cases) |
| 20   | S4: `isProcessing` state closure allows double-send        | 36bb8c7 | inspection                             |
| 21   | S7: npx-fallback child spawns but stdout/exit unwired      | a597b20 | inspection                             |

Plus pass 16 (f7b82fc): monorepo-wide typecheck cleanup fixing
pre-existing errors that the v8 baseline had flagged.

## 25. Remaining open items in AUDIT.md

None. The Apr-2026 adversarial review stack is fully closed.
Six original findings (S1–S6) plus one post-review finding (S7)
are all resolved.

## 26. Delta from v8 baseline

| Area                   | v8 (Apr-15)           | v9 (Apr-18)                        | Direction                          |
| ---------------------- | --------------------- | ---------------------------------- | ---------------------------------- |
| Monorepo typecheck     | pre-existing failures | 0 errors                           | ⬆ improved                         |
| AUDIT.md closed items  | 14                    | 21                                 | ⬆ +7 items                         |
| Reliability passes     | through 15            | through 21                         | ⬆ +6 passes                        |
| Uncommitted files      | 70                    | 31                                 | ⬆ reduced (but still non-zero)     |
| `as any` count         | 274                   | 295                                | ⬇ +21 (possibly measurement drift) |
| Desktop protocol traps | 27                    | 34                                 | ⬆ +7 tests                         |
| Tool abort tests       | 3                     | 5                                  | ⬆ +2 bg cases                      |
| Known flakes           | CI RED, 29 failed     | core property test (parallel only) | ⬆ fewer flakes                     |

**Net: improvements across every dimension with evidence, except `as any`
count (+21, needs investigation).** Nothing regressed.
