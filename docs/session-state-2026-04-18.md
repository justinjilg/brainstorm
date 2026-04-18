# Session Checkpoint — 2026-04-18

Written before context compaction. A future session (or a fresh
contributor) can pick up from here.

**HEAD:** `9ec3405` on `origin/main`.

## Arc of this session

- **16 reliability passes** (17 → 32) landed, each with a commit and
  (where possible) a regression trap.
- **5 stochastic assessment rounds** (v9 → v10 → v11 → v12 + Phase-4
  auditor each). Trajectory: 5.36 (v8 pre-session) → 5.76 → 5.96 →
  5.90 (methodology rerun) → 5.97 (bypass hunt).
- **2 CI ratchets** committed:
  - `check-as-any-budget.mjs` (pre-install, supply-chain safe) —
    currently 285/285.
  - `check-dep-cruiser.mjs` (post-install, needs the installed
    binary) — currently 0/0.

## Test + budget baselines at `9ec3405`

| Package / tier            | Tests                  | Notes                                                     |
| ------------------------- | ---------------------- | --------------------------------------------------------- |
| `@brainst0rm/tools`       | 119 / 21 skipped       | +13 since v11 (env scrub prefix, path blocks, `_KEY` gap) |
| `@brainst0rm/db`          | 35                     | +2 concurrent-writer traps                                |
| `@brainst0rm/core`        | 410                    | unchanged this session (parallel-turbo flake carryover)   |
| `@brainst0rm/cli`         | 187                    | unchanged                                                 |
| `@brainst0rm/vault`       | 56                     | unchanged                                                 |
| Desktop protocol          | 34                     | unchanged                                                 |
| Desktop mocked Playwright | 79                     | unchanged                                                 |
| AUDIT.md closed items     | 27                     | +13 since v8                                              |
| as-any budget             | 285/285                | ratchet enforced                                          |
| dep-cruiser budget        | 0/0                    | ratchet enforced                                          |
| Typecheck                 | 0 errors monorepo-wide |                                                           |

## Passes landed this session

| Pass    | Source                   | Fix                                                                                            | Trap                                   |
| ------- | ------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| 16      | pre-v8 typecheck cleanup | Fix 8 pre-existing failures                                                                    | —                                      |
| 17 (S6) | Apr-review               | Pending IPC rejects on backend exit                                                            | inspection                             |
| 18 (S5) | Apr-review               | Partial replies flagged on mid-stream error                                                    | `finalize-turn.test.ts` (7 cases)      |
| 19 (S2) | Apr-review               | Background shell honours AbortSignal                                                           | `shell-abort.test.ts` (2 new)          |
| 20 (S4) | Apr-review               | `isProcessing` race closed with ref                                                            | inspection                             |
| 21 (S7) | post-review              | npx-fallback child gets full stdio wiring                                                      | inspection                             |
| 22      | v9 consensus             | as-any ratchet committed                                                                       | `check-as-any-budget.mjs`              |
| 23      | v9 consensus             | Working tree 31 → 9 + gitignore                                                                | inspection                             |
| 24 (A1) | v9 Attacker              | Docker sandbox 6 hardening flags + default "restricted"                                        | 1 restricted-default trap              |
| 25 (A2) | v9 Attacker              | `buildChildEnv()` env scrubber                                                                 | 6 env-scrub traps                      |
| 26 (C1) | v9 Chaos                 | SQLite WAL corruption recovery                                                                 | `wal-recovery.test.ts` (3 cases)       |
| 27      | v11 Attacker             | `OP_SESSION_<id>` prefix scrub                                                                 | 3 prefix traps                         |
| 28      | v11 Chaos                | SQLite `busy_timeout=5000`                                                                     | `concurrent-writers.test.ts` (2 cases) |
| 29      | v11 Operator             | CI ratchet wire-up                                                                             | ci.yml step                            |
| 30      | v11 Attacker             | Sensitive-path read blocks (9 paths)                                                           | 10 path traps                          |
| 31      | v12 Attacker/Operator    | Env regex `_KEY`/`_AUTH`/... + `KEY$`; CI step moved before `npm ci`; `/var/root/.ssh` pattern | 3 new                                  |
| 32      | v9-v12 Architect         | `dep-cruiser` with `no-circular` rule                                                          | `check-dep-cruiser.mjs`                |

## Open items (deferred, documented)

### Design-level (not a surgical pass)

- **F3 busy_timeout TUI UX stall** (v12 Pessimist + Chaos). `better-sqlite3`
  is synchronous; 5000ms timeout blocks the Ink event loop silently.
  Fix requires async sqlite driver OR TUI progress wiring. Not a
  regex-sized change.
- **F5 shell string-trick bypasses** (v12 Attacker, Auditor-verified):
  `cat $(echo ~)/.ssh/id_rsa`, `cat /U""sers/$USER/.ssh/…`, hex in
  subshells, glob expansion. Code comment in `sandbox.ts` already
  says "path-name defense, not a real capability sandbox" — true fix
  needs `shell-quote` AST parsing or containerization.

### Multi-round carryovers

- **`continue-on-error: true`** on core + vault CI test steps (5/10
  v12 consensus, 2+ rounds). Flagged as TODO debt in ci.yml:60-73
  with rationale. Root-cause: HOME/filesystem differences in GitHub
  Actions vs local — tests pass in isolation.
- **ENOSPC + Docker daemon death traps** (Chaos, 3 rounds). Chaos's
  original 3-corruption-surface ask — 1 closed (WAL), 2 open. Next
  move: `enospc.test.ts` + `docker-daemon-death.test.ts` following
  the `wal-recovery.test.ts` template.
- **Telemetry** (Auditor + Competitor + Pragmatist, structural). Zero
  runtime signal. Can't move Production Evidence above ~4.78 without.
- **Parallel turbo test flake** on core property test (2 rounds).
  Resource contention when full monorepo runs — passes alone.

### Single-round items not yet addressed

- **npm audit** flagged 3 vulnerabilities (2 moderate, 1 high) from
  the dep-cruiser install. Not investigated.
- **Additional dep-cruiser rules**: no-orphans, barrel-only-imports,
  apps-cant-import-apps — each would land with its current violation
  count as baseline, mirroring the as-any ratchet pattern.
- **Dep-cruiser cycle fix in traceability** found and fixed in pass
  32 (index.ts ↔ mcp-tools.ts). If other cycles appear, the ratchet
  catches them.

## Key patterns established this session

1. **CI ratchet pattern** (`check-*.mjs` scripts) — same script shape
   for as-any and dep-cruiser. Easy to extend to any countable
   quality metric (timer leaks, orphan modules, cross-package deep
   imports, bundle size).
2. **Trap-per-finding discipline** — every closed AUDIT item has a
   commit SHA and (where behaviorally trappable) a named test file.
   Audit-grade traceability.
3. **S/A/C finding-name convention** — S-series from Apr adversarial
   review, A-series from Attacker persona, C-series from Chaos
   Monkey. Referenced in commits + AUDIT.md entries.
4. **Phase-4 Auditor catches hallucinated findings** — v12 caught 2
   of 6 agent claims as false (`.` in regex actually IS escaped;
   `/private/etc/shadow` already matches via unanchored regex). The
   orchestrator (me) was carrying findings without verifying — the
   Auditor step is load-bearing.
5. **Assessment meta-insight** — σ 0.07 (v10) / 0.05 (v11) / 0.10
   (v12) showed tight agreement is real when evidence is unambiguous
   BUT mean drifts ±0.1 on independent replication. The **finding
   list is the payload**, the score is directional at ±0.1.

## Natural next moves (in rough priority order)

1. **npm audit fix** on the dep-cruiser-introduced vulnerabilities (3
   total, 1 high) — triage whether patched versions exist and lift
   lockfile.
2. **Root-cause core + vault CI env issue** so `continue-on-error`
   can come off. 5-round carryover. Needed to turn CI-green into an
   actual signal.
3. **ENOSPC + Docker-daemon-death traps** — port the WAL template
   to two more corruption surfaces. Closes Chaos's 3-round ask.
4. **Additional dep-cruiser rules** — start with `no-orphans` +
   `no-deep-import` (force cross-package imports via index barrel).
   Each with committed baseline count.
5. **Opt-in telemetry beacon** — first move toward lifting
   Production Evidence above the 4.78 ceiling. Requires design work
   (what to send, PII handling, disclosure).
6. **F3 busy_timeout UX fix** — either swap better-sqlite3 for an
   async driver OR add Ink spinner wiring around DB-heavy paths.
7. **F5 capability sandbox** — replace regex defense with
   `shell-quote` AST parsing, OR flip default to `"container"` for
   untrusted workloads.

## Assessment philosophy (what this session taught us)

- **Running the same assessment twice on the same state catches real
  bugs the first round missed.** v11 (no-work rerun) found 5
  substantive findings v10 missed, including 3 real security issues.
- **Targeted bypass-hunting (v12) produces a different class of
  finding**: bypasses of the recently-closed fixes. Expected. The
  widest σ round of the session.
- **The score is a directional signal, not a measurement.** Any
  claim at ±0.1 precision is noise. The finding list is the real
  output.
- **Assessment rounds have diminishing returns per round** but
  compound across rounds — v13+ would still find things, but mostly
  at the next-layer-down of whatever just landed.

## How to resume

```bash
cd /Users/justin/Projects/brainstorm
git log --oneline -5  # confirm at 9ec3405 or descendant
node scripts/check-as-any-budget.mjs    # should print 285/285
node scripts/check-dep-cruiser.mjs      # should print 0/0
npx turbo run build                     # 29/29 green
```

Then pick one from "natural next moves" above. The CI ratchets + trap
discipline + AUDIT.md are the load-bearing infrastructure; anything
new fits into those shapes.
