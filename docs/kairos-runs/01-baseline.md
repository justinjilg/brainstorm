# KAIROS Dogfood Run #1 — Baseline

**Date:** 2026-04-11
**Duration:** ~7 minutes (4 ticks)
**Cost:** $3.27 (terminated by per-session budget cap of $3.00)
**Outcome:** ✅ 6 new tests across 2 packages, all passing

This is the first end-to-end production run of `brainstorm chat --simple --daemon`
on the brainstorm repo itself. Per the plan in `linked-crunching-hamming.md`,
Phase 0 dogfooding before any of the three transformations.

## Setup

```bash
# 1. brainstorm onboard . --budget 1.50
# 2. brainstorm chat --simple --daemon --lfg --strategy capability
```

Project-scoped `brainstorm.toml`:

```toml
[budget]
perSession = 3.0
hardLimit = true

[general]
defaultStrategy = "capability"
defaultPermissionMode = "auto"

[daemon]
tickIntervalMs = 30000
maxTicksPerSession = 200
```

Initial task injected via stdin:

> KAIROS Dogfood Run #1. Add meaningful unit tests to the three packages with
> the LOWEST test coverage: packages/db, packages/onboard, and packages/server.
> For each package, add at least 3 focused tests covering real code paths.
> Read source first, run vitest after, commit only if tests pass.
> Total session budget is $3 — be efficient.

## Lowest-coverage packages (test_files / src_lines)

| Package    | Src lines | Test lines | Test files | Ratio |
| ---------- | --------- | ---------- | ---------- | ----- |
| db         | 1756      | 136        | 1          | 0.08  |
| vscode     | 326       | 32         | 1          | 0.10  |
| code-graph | 748       | 295        | 1          | 0.39  |
| onboard    | 2900      | 497        | 2          | 0.17  |
| server     | 1453      | 273        | 2          | 0.19  |

(KAIROS targeted db, onboard, server per the plan's literal wording.)

## Outcome

| Package | New test file                                 | Tests | Pass   |
| ------- | --------------------------------------------- | ----- | ------ |
| db      | `src/__tests__/repositories.test.ts`          | 3     | ✅ 3/3 |
| onboard | `src/__tests__/memory-bridge.test.ts`         | 3     | ✅ 3/3 |
| server  | (not started — budget hit before reaching #3) | 0     | —      |

```
$ npx vitest run packages/db/src/__tests__/repositories.test.ts
 ✓ packages/db/src/__tests__/repositories.test.ts (3 tests) 13ms
 Test Files  1 passed (1)
      Tests  3 passed (3)

$ npx vitest run packages/onboard/src/__tests__/memory-bridge.test.ts
 ✓ packages/onboard/src/__tests__/memory-bridge.test.ts (3 tests) 501ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

The tests are real — they import actual exports from the packages, exercise
real code paths (`SessionRepository.create`, `persistOnboardToMemory`,
`MemoryManager.listByTier`), and assert on real behavior. Not stubs.

## Tick-by-tick

| Tick | Cost    | Cumulative | What happened                                                                 |
| ---- | ------- | ---------- | ----------------------------------------------------------------------------- |
| #1   | $0.0299 | $0.030     | Daemon woke, no user message yet, ran intro tick                              |
| #2   | $1.1973 | $1.227     | Task injected → explored db package, read existing tests, started writing     |
| #3   | $1.0581 | $2.285     | Wrote db test file, ran vitest, started onboard exploration                   |
| #4   | $0.7323 | $3.018     | Wrote onboard test file, started server but budget tripped                    |
| —    | —       | $3.27      | Circuit breaker stopped daemon after 3 consecutive `BUDGET_EXCEEDED` failures |

## Tool call distribution (from trajectory JSONL, 110 calls total)

| Tool              | Count |
| ----------------- | ----- |
| file_read         | 51    |
| build_verify      | 18    |
| shell             | 12    |
| glob              | 7     |
| grep              | 4     |
| file_edit         | 3     |
| list_dir          | 3     |
| file_write        | 2     |
| task_create       | 2     |
| task_update       | 2     |
| task_list         | 2     |
| git_status        | 2     |
| begin_transaction | 1     |
| git_diff          | 1     |

**Read:Edit ratio: 51 / 5 = 10:1** — well above the quality-signals threshold
of 3:1. The agent did its homework.

The agent used `task_create`/`task_update` for its own work tracking, ran
`build_verify` 18 times to keep checking it didn't break the build, and
even used the transaction tool. It used the system the way it was designed
to be used.

## What worked

1. **Per-session budget cap stopped the run cleanly.** $3 cap → daemon hit
   $3.27, circuit breaker tripped after 3 consecutive `BudgetExceededError`,
   logged the reason, exited. No runaway spend.
2. **Capability routing strategy.** Daemon picked Gemini Flash first
   (highest measured `codeGeneration` score), and when Gemini failed, fell
   back through Kimi K2.5 successfully.
3. **Trajectory recording** captured all 110 tool calls + 12 routing
   decisions + 46 LLM calls. The auto-trajectory-analyzer ran after tick 1
   and updated `~/.brainstorm/routing-intelligence.json`.
4. **Quality signals middleware** flagged low Read:Edit ratio twice during
   the run (1:3 then 15:6), surfacing the agent's working state in real time.
5. **The agent produced real, passing tests** that import real code.
6. **`brainstorm onboard`** completed in 136s for $0.02, generated 9 agent
   profiles, 24 routing rules, BRAINSTORM.md, and 6 memory entries.

## What broke

### Bug 1: `brainstorm memory list` reads the wrong store

`onboard` writes 6 memory entries to
`~/.brainstorm/projects/<hash>/memory/*.md` (file-backed, with its own git
repo for versioning). But `brainstorm memory list` queries the `project_memory`
SQLite table, which is **empty**. Two memory systems exist in parallel and
neither sees the other.

**Severity:** medium. User can't verify onboard worked from the CLI.

### Bug 2: Gemini API rejects mid-conversation system messages

Every tick after #1 attempted Gemini Flash first (capability strategy
preference) and failed with:

```
AI_UnsupportedFunctionalityError: 'system messages are only supported at
the beginning of the conversation' functionality not supported.
```

The session history accumulates `[system, user, assistant, system, user, ...]`
across ticks because daemon mode reuses the session and each tick may inject
a fresh system segment. Gemini rejects this; Anthropic and OpenAI accept it.
The router fell back to Kimi K2.5 every time, but **wasted ~30% of tick time
on the failed attempt before falling back**.

**Severity:** high — every tick costs ~30% extra and the routing decision is
biased against the model that should win on measured codeGeneration.

**Fix:** when building the message history for Gemini, collapse all system
messages into the first one (or convert subsequent system messages into
user-role messages). This needs to live in the provider-specific message
formatter, not the daemon.

### Bug 3: Quality-signals middleware fires too eagerly

The Read:Edit ratio warning fires at the FIRST write event before the agent
has had a chance to balance reads. The 1:3 warning at tick 2 is a false
positive — by end of run the ratio was 10:1.

**Severity:** low. The signal was correct in aggregate, just noisy
mid-stream.

**Fix:** require a minimum sample size (e.g., ≥ 5 writes) before the
threshold check fires.

### Bug 4: Daily budget cap hit pre-existing spend

First daemon launch tried `daily = 5.0`. The CostTracker reported
"Budget exceeded: daily — used $34.5545 of $5.00" and the circuit breaker
tripped before the daemon could even take its first user message. Today's
real spend was $67.54 from prior SWE-bench + autonomous test sessions.

The behavior is technically _correct_ — if you set a daily cap you should
expect it to enforce — but the UX is confusing because there's no warning
that the cap is already blown when you start a session.

**Severity:** low. Documentation issue more than a bug.

**Fix:** at daemon start, if any active budget cap is already exceeded,
warn and refuse to start with a clear message, OR reset the per-session cost
counter independent of daily.

### Bug 5: `BRAINSTORM.md` frontmatter validation rejects legitimate values

On every CLI invocation:

```
{"errors":["deploy: Invalid enum value. Expected
'vercel' | 'do-app-platform' | 'docker' | 'aws' | 'none', received
'npm (packages), electron (desktop application)'"], ...
"msg":"Invalid STORM.md frontmatter — ignoring structured data"}
```

The onboard pipeline writes a deploy field that doesn't match the schema's
enum. The frontmatter parser then drops ALL the structured data silently
(only logs at warn level). The LLM-driven onboard generated a string that
the schema-driven loader rejects.

**Severity:** medium. Onboard's output is silently discarded.

**Fix:** either widen the deploy enum or have the onboard prompt constrain
the LLM to the valid values.

## Quality signals captured

- 2x Read:Edit ratio warnings (early in run, recovered by end)
- 0x stop-phrase violations
- 0x convention violations
- 0x fleet-quality regressions

## Changes to commit

```
?? packages/db/src/__tests__/repositories.test.ts        (98 lines, 3 tests)
?? packages/onboard/src/__tests__/memory-bridge.test.ts  (135 lines, 3 tests)
M  brainstorm.toml                                       (added [budget] perSession)
?? docs/kairos-runs/01-baseline.md                       (this file)
?? docs/kairos-runs/01-onboard.log                       (onboard log)
```

The .brainstorm/ directory of generated agents, routing rules, BRAINSTORM.md,
and project memory files is intentionally NOT being committed in this
artifact — those are environment-local outputs of `brainstorm onboard`.

## Verdict

**KAIROS works.** It autonomously completed real software engineering work,
ran its own tests, respected the budget cap, and produced output that
passes verification.

It also surfaced 5 real bugs, which is the entire point of the dogfood run.

Next: fix bug #2 (Gemini system message handling) so the daemon doesn't
waste 30% of every tick on a doomed first attempt. Then run KAIROS Dogfood
Run #2 with a higher budget and longer time horizon, targeting the third
package (server).
