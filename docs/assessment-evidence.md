# Assessment Evidence v6 — Brainstorm Platform (2026-04-09)

Previous assessments focused on desktop app (3.2→4.0→3.43→4.68).
This assessment: full platform readiness for the autonomous agent vision.

## Scope

Vision under assessment: "Attack large software projects, ingest them, document and become experts in the code, then call agents with skills from different models to concurrently work on projects for long periods using KAIROS and BR memory."

A 5-phase plan has been approved to wire the last mile (see /Users/justin/.claude/plans/linked-crunching-hamming.md).

Context: Stella Laurenzo report (anthropics/claude-code#42796) — 17,871 thinking blocks analyzed, Read:Edit ratio 6.6→2.0 degradation, 173 stop-hook violations, 80x API request increase from thrashing. Lessons inform Phase 4 (Quality Observability).

## 1. Code Inventory (source lines / test lines)

| Package      | Source Lines | Test Lines | Test Ratio |
| ------------ | ------------ | ---------- | ---------- |
| core         | 20,820       | 2,069      | 9.9%       |
| cli          | 12,683       | 948        | 7.5%       |
| tools        | 8,159        | 1,108      | 13.6%      |
| godmode      | 4,603        | 143        | 3.1%       |
| router       | 2,949        | 814        | 27.6%      |
| onboard      | 2,722        | 0          | 0%         |
| db           | 1,964        | 208        | 10.6%      |
| eval         | 1,944        | 367        | 18.9%      |
| workflow     | 1,743        | 245        | 14.1%      |
| ingest       | 1,379        | 0          | 0%         |
| agents       | 1,262        | 160        | 12.7%      |
| providers    | 1,242        | 74         | 6.0%       |
| config       | 996          | 147        | 14.8%      |
| hooks        | 894          | 187        | 20.9%      |
| gateway      | 764          | 0          | 0%         |
| vault        | 707          | 127        | 18.0%      |
| scheduler    | 693          | 0          | 0%         |
| docgen       | 625          | 0          | 0%         |
| projects     | 576          | 0          | 0%         |
| onboard      | 2,722        | 0          | 0%         |
| orchestrator | 500          | 0          | 0%         |
| mcp          | 452          | 48         | 10.6%      |
| plugin-sdk   | 344          | 0          | 0%         |
| shared       | 1,601        | 398        | 24.9%      |
| vscode       | 326          | 0          | 0%         |
| sdk          | 217          | 0          | 0%         |
| **TOTAL**    | **71,420**   | **7,043**  | **9.9%**   |

Packages with ZERO tests: onboard, ingest, docgen, gateway, scheduler, projects, orchestrator, plugin-sdk, vscode, sdk, server (11 of 26 packages).

## 2. Test Results

**Passing:**

- @brainst0rm/core: 9 test files, 150 tests passed
- @brainst0rm/tools: 3 test files passed + 1 skipped, 80 passed + 21 skipped
- @brainst0rm/router: 4 test files, 63 tests passed
- @brainst0rm/shared: 2 test files, 23 tests passed

**Failing:**

- @brainst0rm/gateway: vitest exits code 1 (no test files exist but test script defined)
- @brainst0rm/db: test script fails (vitest exit 1 after passing 9 migration tests)
- @brainst0rm/hooks: test script fails
- @brainst0rm/plugin-sdk: test script fails
- @brainst0rm/web: build fails (pnpm/npm workspace conflict)

**Not runnable / no test script:**

- Multiple packages have test scripts pointing to vitest but no test files

Total verifiable: 316 tests pass, 21 skipped. Multiple packages fail due to vitest config, not test failures.

## 3. Wiring Audit — Critical Functions

| Function                      | Defined In                              | Called From CLI/Entrypoint?             | Status        |
| ----------------------------- | --------------------------------------- | --------------------------------------- | ------------- |
| `createWiredMemoryTool()`     | tools/builtin/memory-tool.ts:79         | NO — only in own file + index.ts export | **NOT WIRED** |
| `createMemoryTools()`         | tools/builtin/memory-tools.ts           | NO — only in own file + index.ts export | **NOT WIRED** |
| `PhaseDispatcher` interface   | core/plan/orchestration-pipeline.ts:160 | NO — zero implementations exist         | **NOT WIRED** |
| `SubagentPhaseDispatcher`     | does not exist                          | N/A                                     | **NOT BUILT** |
| `persistOnboardToMemory()`    | does not exist                          | N/A                                     | **NOT BUILT** |
| quality-signals middleware    | does not exist                          | N/A                                     | **NOT BUILT** |
| stop-detection middleware     | does not exist                          | N/A                                     | **NOT BUILT** |
| fleet-signals middleware      | does not exist                          | N/A                                     | **NOT BUILT** |
| convention-monitor middleware | does not exist                          | N/A                                     | **NOT BUILT** |
| memory-manager tests          | does not exist                          | N/A                                     | **NOT BUILT** |
| kairos-full-loop tests        | does not exist                          | N/A                                     | **NOT BUILT** |

## 4. Dependency Map — Orphan Packages

| Package        | Imported By N Other Packages |
| -------------- | ---------------------------- |
| shared         | 101 (hub)                    |
| tools          | 31                           |
| config         | 21                           |
| ingest         | 19                           |
| db             | 17                           |
| providers      | 10                           |
| core           | 8                            |
| router         | 8                            |
| gateway        | 6                            |
| agents         | 5                            |
| workflow       | 4                            |
| projects       | 3                            |
| godmode        | 3                            |
| orchestrator   | 2                            |
| eval           | 2                            |
| docgen         | 2                            |
| onboard        | 1                            |
| hooks          | 1                            |
| mcp            | 1                            |
| scheduler      | 1                            |
| vault          | 1                            |
| server         | 1                            |
| **cli**        | **0 (leaf — entrypoint)**    |
| **plugin-sdk** | **0 (leaf — standalone)**    |
| **vscode**     | **0 (leaf — standalone)**    |
| **sdk**        | **0 (leaf — standalone)**    |

## 5. Git Log (recent 20 commits)

All 20 recent commits are desktop app focused:

- ab8c10c fix(desktop): abortChat wired, crash handlers, structured logging
- 4396ee7 fix(desktop): 19 TypeScript errors fixed
- 195ccf7 feat(desktop): KAIROS start/stop buttons in Navigator
- ae6268b fix(desktop): strategy read-only + hooks tests
- e1bed5e feat(desktop): auto-update + vault/MCP test coverage
- 3188f2a fix(desktop): zero as-any casts, zero hardcoded data
- 616a0ed feat(desktop): real workflow execution
- 572d36f fix(desktop): complete wiring audit
- a0b23e8 feat(desktop): notarized DMG, CSP, 674 tests
- 769375e fix(core): 4 bugs fixed, 643 tests zero failures
- 8620c02 feat(desktop): Electron app with IPC backend — 4.0/10 → targeting 7.0
- ... (all desktop)

No recent commits to: memory system, onboard pipeline, orchestrator, quality observability, ingest pipeline, docgen.

## 6. What's Built vs What's Paper-Complete

### BUILT AND WORKING (verified by tests or manual inspection)

- DaemonController (KAIROS tick loop, cost pacing, approval gates) — 13 tests pass
- MemoryManager class (save, search, tiers, trust scoring, git versioning) — 840 lines, NO tests
- Memory extraction middleware — tested in middleware pipeline (10 tests)
- Semantic search (TF-IDF) — 9 tests pass
- Router (heuristic classifier, 6 strategies, cost tracker) — 63 tests pass
- Tool system (42+ tools, sandbox, permissions) — 80 tests pass
- Agent profiles (14 roles, DB persistence) — code exists, 160 test lines
- Subagent spawning (8 types, budget guards, privilege reduction) — code exists in loop integration tests
- Ingest pipeline (dependency graphs, framework detection, complexity) — code exists, 0 tests
- Docgen (architecture/module/API docs) — code exists, 0 tests
- Style learner — code exists, tested within skills-loader tests
- Repo map — code exists, no dedicated tests
- Orchestration pipeline (9 phases, F1 scoring, trajectory capture) — code exists, 0 tests, NO dispatcher
- Workflow engine (confidence escalation, kill gates) — 245 test lines
- Onboard pipeline (convention inference, domain extraction) — code exists, 0 tests
- Middleware pipeline (20 middlewares) — 10 tests for pipeline, individual middleware tests vary
- Desktop app (Electron + React 19, KAIROS UI, IPC) — extensive recent work

### NOT BUILT (required by plan)

- SubagentPhaseDispatcher (connects orchestrator to subagents)
- Onboard-to-memory bridge (persists analysis to memory)
- Quality observability middlewares (Read:Edit, stop detection, convention, fleet)
- ProjectMemoryRepository (CRUD for project_memory SQLite table)
- Memory tool wiring in CLI entrypoints
- MemoryManager test suite
- KAIROS full-loop integration test

## 7. Memory System Specifics

- Storage: file-based markdown with YAML frontmatter in `~/.brainstorm/projects/<hash>/memory/`
- Cap: 25KB total (MAX_MEMORY_BYTES) with LRU eviction
- Trust scores: user_input (1.0), dream_consolidation (0.7), agent_extraction (0.5), web_fetch (0.2)
- System prompt budget: 800 tokens for system-tier memories
- The memory TOOL (agent-callable) is a stub — always returns error
- The 4-tool set (memory_save/search/list/forget) is defined but never registered
- MemoryManager class has 0 test files
- Dream consolidation exists but subagent spawn may not resolve

## 8. Key Architectural Constraints

- ESM throughout, tsup bundling, .js extensions for inter-package imports
- AI SDK v6 patterns (streamText, tool() with Zod inputSchema)
- SQLite with WAL mode at ~/.brainstorm/brainstorm.db
- Subagent spawning is SEQUENTIAL ONLY — no parallel subagent execution
- Tool parallelism exists (parallel-safe classification) but only within a single agent
- Scheduler has maxConcurrent=3 config but trigger execution is sequential
- Context window management: proactive compaction middleware exists
