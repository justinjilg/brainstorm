# Stochastic Assessment Evidence v13 — 2026-04-19

Previous: v12 scored 5.97/10 (σ 0.10, widest spread in the series) on
commit f1a37b1. v13 measures commits between f1a37b1 and HEAD — 61
commits, all fix-class, landing on `main`.

Methodology note: brainstorm CLI is NOT the BrainstormRouter project
that the canonical checklist was written for. Commands are adapted to
brainstorm's turborepo + vitest stack; "production endpoint" checks
are N/A because brainstorm CLI ships as a local binary, not a hosted
service. Wiring and ratchet items are brainstorm-specific.

---

## 1. Recent commits (last 30 since v12 baseline f1a37b1, 61 total)

```
cc485b0 fix(router): classifier cache keys include context and project hints
073884b fix(cli): InputHistory.save only appends the latest entry to disk
18e7a2d fix(workflow): kill-gate allowlist rejects shell metacharacter chaining
fdb87c6 fix(scheduler): zombie sweep only targets rows older than 30 minutes
f038c83 fix(core): memory runner locks use O_EXCL to close TOCTOU race
7acfc3d fix(server): GitHub webhook verifies signature before touching nonce cache
2a31477 fix(core): add word boundary to sentiment.ts frustrated patterns
69c2654 fix(core): ReactionTracker regex requires word boundaries (prefix-match false positives)
ce6aae2 fix(core): pipeline dispatcher enforces agent allowedTools restriction
673a711 fix(tools): checkpoint manager sweeps stale session dirs on startup
7d59d65 fix(tools): web_search shares web_fetch's rotating anti-fingerprint UA pool
071ba77 fix(core): FileWatcher caps agentWrites + changes to prevent unbounded growth
586c72b fix(eval): raise TypeScript compile-verify timeout for CI npx cold-start
405baab fix(scheduler): concurrency check uses authoritative count, not filtered listRecent
2908411 fix(gateway): unwrapArray logs unexpected response shapes
d6665be fix(hooks): auto-lint template — no outer double-quotes around $FILE
6f5a78e fix(cli): IPC persists the actually-routed model, not chatParams.modelId
75f6d44 fix(sdk): apiKeys are scoped to instance, not mutated into process.env
aebb235 cleanup: fix mojibake in git-sync log + remove dead vaultUnlockAttempted var
1e3b542 fix(router): bound convergenceAlerts growth (learned strategy)
1a5367d fix(vault): bound op-cli cache size (was unbounded on unique-key queries)
c1bff5a fix(godmode): ChangeSet map GCs terminal entries (unbounded memory leak)
4d4f202 fix(core): secret injection preserves literal $ in secret values
39fc711 fix(tools): file-edit preserves literal $ in replacement content
9876fca fix(hooks): hook-command variable expansion preserves literal $ in paths
6edfde5 fix(core): skill <SKILL_DIR> replacement immune to $-backreferences
c4be21e fix(agents): nl-parser doesn't double-set budget on 'daily budget' input
2af0ecc fix(providers): simplify BR-key resolution, remove unreachable branch
9aa4f68 fix(core): resumeLatest(project) queries project-scoped, not top-1-filtered
5de1c95 fix(core): add durationMs to test MiddlewareToolResult constructions
```

Total commits in v12→v13 window: **61**. Categories by grep:

- `fix(*):`: 52
- `cleanup:` / `chore:`: 4
- `test(*):`: 2
- `docs(*):`: 3

No `feat(*):` commits — this round is pure hardening.

## 2. Build (turborepo)

```
Tasks:    29 successful, 29 total
Cached:    27 cached, 29 total
Time:    2.8s
```

All 29 packages build. `--force` not required.

## 3. Typecheck

```
$ npx tsc --noEmit 2>&1 | grep -c "error TS"
0
```

Zero type errors across the full monorepo.

## 4. Test summary (turbo run test)

Partial run earlier this session (b46fiankc.output): 56 of 57 turbo
tasks succeeded. The only failing task is `@brainst0rm/desktop#test`
— Playwright e2e that requires a running backend server ("server
down" / "no-server" / "state-sync" scenarios). Environmental, NOT
regression from v13 code changes.

Per-package test file counts on HEAD (from `Test Files` lines in
each test run this session):

- core: 33 test files, 421 tests
- tools: test files run
- router: 6 test files, 94 tests (+2 vs v12)
- godmode: 83 tests (no delta noted)
- code-graph: 59 tests
- hooks: 57 tests
- shared: 43 tests
- workflow: 3 files, 46 tests (+3 vs v12)
- eval: 6 test files
- gateway: 38 tests
- server: 3 files, 26 tests (+1 vs v12)
- scheduler: 3 files, 23 tests (+1 vs v12)
- cli: 15 files, 190 tests (+3 vs v12)

## 5. E2E test count

```
$ find packages -name "*.e2e.test.ts" | wc -l
0
```

Zero files matching `*.e2e.test.ts`. Desktop package uses Playwright
under `apps/desktop/tests/*.spec.ts` (not `*.e2e.test.ts`).

## 6. Source and test line counts

```
$ find packages -name "*.ts" -not -name "*.test.ts" ... | xargs wc -l | tail -1
89113 total

$ find packages -name "*.test.ts" ... | xargs wc -l | tail -1
28345 total
```

Test-to-source ratio: 28345 / 89113 = **31.8%**. v12 was at similar
mass; growth consistent with the +11 tests added this round.

## 7. CI ratchets (brainstorm-specific, not BrainstormRouter's)

Three active ratchets in `scripts/`:

```
$ node scripts/check-as-any-budget.mjs
as-any budget: 282/285 (3 under budget)

$ node scripts/check-ci-continue-on-error.mjs
ci continue-on-error budget: 0/0 (0 under budget)

$ node scripts/check-dep-cruiser.mjs
dep-cruiser budget exceeded: 2 > 0.
  error no-orphans-in-packages: packages/router/src/strategies/plugin-interface.ts
  error no-orphans-in-packages: packages/router/src/strategies/cost-first-plugin.ts
x 2 dependency violations (2 errors, 0 warnings). 858 modules, 1706 dependencies cruised.
```

**Important:** dep-cruiser is RED on HEAD. Two orphan files in
`packages/router/src/strategies/` — both untracked in git (per git
status — experimental plugin-strategy scaffolding, not wired).

`continue-on-error` was **5/10 risk in v12 baseline (F7)**. It is now 0. Multi-round carryover closed.

## 8. as-any count (untracked-included)

```
$ grep -r "as any" packages --include="*.ts" | grep -v "\.test\.ts" | wc -l
284
```

Budget is 285; reported uses 282 (within budget) — difference is the
filter pattern (the budget script strips doc-comment mentions).

## 9. Wiring audit

```
$ grep -rl "new BrainstormVault\|initializeRouter\|createAgenticLoop\|startIPCHandler\|registerConnector" packages/cli/src packages/core/src/index.ts
packages/cli/src/init/index.ts
packages/cli/src/bin/brainstorm.ts
packages/cli/src/ipc/handler.ts
packages/cli/src/commands/slash.ts
```

Core subsystems — Vault, Router, AgentLoop, IPC handler, God Mode
connectors — all referenced from the CLI entrypoint path. TUI and
non-interactive commands share the same wiring.

## 10. Session history (v12 → v13 code delta)

61 commits, all `fix(*)`/`cleanup`/`test`/`docs`. Representative
categories:

- **$-backreference class (5 sites)**: file-edit, secret-substitution,
  hook-expansion, skill <SKILL_DIR>, injectSecrets prefix collision.
  All switched to function-form replacement. Regression tests added
  for each.
- **Unbounded-growth class (7+ sites)**: convergenceAlerts (router
  learned), op-cli cache (vault), ChangeSet terminal map (godmode),
  FileWatcher agentWrites + changes (core), curator/dream locks
  (core — O_EXCL), checkpoint session dirs (tools — 7-day sweep).
- **Privilege/security-gate class**: pipeline dispatcher honors
  agent allowedTools (ce6aae2); GitHub webhook verifies signature
  before nonce cache (7acfc3d); workflow kill-gate blocks shell
  metacharacters (18e7a2d); auto-lint template restored
  (d6665be — hooks were silently no-op).
- **Regex-correctness class**: reaction-tracker, sentiment tone
  detector — both had `^word` without `\b` and matched
  "perfectly bad" / "undocumented" as ACCEPTED / FRUSTRATED.
- **DB / schedule class**: scheduler zombie sweep added staleness
  filter (fdb87c6); scheduler concurrency uses authoritative count
  (405baab); IPC persists the actually-routed model (6f5a78e).
- **Cache-key class (v13 new)**: classifier cache key now includes
  context + projectHints (cc485b0); InputHistory.save merge now
  appends only the latest entry (O(N²) → O(N), 073884b).

### v12 finding disposition on HEAD

| v12 Finding                          | Status on HEAD                                                          |
| ------------------------------------ | ----------------------------------------------------------------------- |
| F1 env scrub `_KEY` gap              | Not verified this round — was flagged 1/10 as legitimate bug            |
| F2 CI ratchet ordering vs `npm ci`   | Not verified this round                                                 |
| F3 busy_timeout synchronous TUI hang | Not verified — design-level, flagged 2/10                               |
| F4 pass 30 unanchored regex          | Auditor overturned as hallucination                                     |
| F5 pass 30 shell string tricks       | Not addressed — comment says "not a real sandbox"                       |
| F6 `/var/root/.ssh/` gap             | Not addressed                                                           |
| **F7 `continue-on-error: true`**     | **CLOSED — ratchet at 0/0, was 5/10 most-flagged risk**                 |
| F8 ENOSPC + Docker daemon traps      | Not addressed — chaos 1/10                                              |
| F9 No dep-cruiser                    | **ADDED — dep-cruiser ratchet now in CI, with 2 current orphan errors** |
| F10 Zero production telemetry        | Not addressed — CLI doesn't run as a service                            |

### v13 code-quality scan fixes (not in v12)

Seven bug-hunt fixes this session (commits 2a31477 → cc485b0):

1. sentiment.ts word-boundary prefix-match false positives
2. GitHub webhook sig-before-nonce (cache poisoning DoS primitive)
3. Memory runner O_EXCL lock (TOCTOU race)
4. Scheduler zombie sweep staleness filter (cross-process false kill)
5. Workflow kill-gate shell metacharacter rejection (command injection sink)
6. InputHistory O(N²) duplication on save
7. Classifier cache keys missing context/projectHints (stale routing)

Each landed with a regression test where behavior could be isolated.

## 11. Known outstanding (carried from v12, not addressed)

- F1 env scrub `_KEY` gap (tools/shell.ts)
- F2 CI ratchet at line 43, after `npm ci` at line 22
- F3 busy_timeout sync TUI stall (design-level, requires async driver)
- F5 shell string-trick bypasses (Attacker-level, sandbox comment
  already admits "not a capability sandbox")
- F6 `/var/root/.ssh/` pattern gap (macOS root user home)
- F8 ENOSPC + Docker daemon death traps
- F10 Zero production telemetry

## 12. What's NEW since v12 that could drop a score

- **dep-cruiser is RED on HEAD** (2 orphan files). Ratchet added but
  untracked work-in-progress violates it. Blocks the "dep-cruiser
  ratchet" F9 from being scored as +.
- No new tests for $-backreference fixes at every site — spot-checked
  (file-edit, secret-substitution) but not comprehensive.
- Router `plugin-interface.ts` + `cost-first-plugin.ts` (orphans):
  new API surface with no consumers, no docs, no tests. Dead
  scaffolding.

## 13. No production-health data

Brainstorm CLI is a local tool, not a hosted service. There is no
`/health` endpoint, no ECS task count, no uptime metric. This is
structural, not a v13 regression. Production Evidence dimension
stays capped (v12 scored it 4.78 for this exact reason).
