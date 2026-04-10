# Assessment Evidence v7 — Brainstorm Platform (2026-04-10)

Previous assessment: v6 scored 3.95/10. This session: routing fleet fix, 740 tests, autonomous storm runs.

## Code Inventory

27 packages, 366 source files, 66,873 source LOC, 90 test files, 16,914 test LOC.
Test:source ratio: 25.3%.

| Package   | Src Files | Src LOC | Test Files | Test LOC |
| --------- | --------- | ------- | ---------- | -------- |
| core      | 104       | 19,982  | 18         | 4,536    |
| cli       | 22        | 11,528  | 8          | 1,358    |
| tools     | 60        | 7,382   | 7          | 1,325    |
| godmode   | 33        | 4,461   | 3          | 771      |
| onboard   | 17        | 2,900   | 2          | 497      |
| router    | 13        | 2,188   | 5          | 1,222    |
| (21 more) | 117       | 18,432  | 47         | 7,205    |

## Test Results

- **740 tests passing** across 27 packages (vitest)
- 21 tests skipped (GitHub integration — requires auth token)
- 0 real failures (core exit code issue is false positive — all 269 core tests pass)
- Full suite: ~39 seconds

## Wiring Audit

23/27 packages imported by CLI entrypoint. Unwired: vscode (extension), sdk (external client), web (gitignored/broken).

| Feature                   | Wired | Grep Count         |
| ------------------------- | ----- | ------------------ |
| Memory tool               | YES   | 24                 |
| Code graph tools          | YES   | 3                  |
| Trajectory recording      | YES   | 6 in loop.ts       |
| Analyzer (learning loop)  | YES   | 2 in loop.ts       |
| Router loads intelligence | YES   | 5 in router.ts     |
| Trust propagation         | YES   | 6 in loop.ts       |
| KAIROS checkpoint         | YES   | 2 in controller.ts |

## Integration vs Mock

- 16 files use real I/O (fs, SQLite, tmpdir)
- 66 files mock-only (vi.mock, vi.fn)
- Ratio: 19.5% integration / 80.5% mock

## Production State

- 10 clean trajectory files (post-fix), 53 archived (pre-fix)
- routing-intelligence.json: 5 models, 4 providers, all verified live
- brainstorm.db: 1.6 MB SQLite (sessions, costs, agents)
- No running server — CLI tool
- No Docker — local dev only
- CI pipeline defined (.github/workflows/ci.yml) but not active on GitHub

## Routing Intelligence

Models tracked (capability strategy, auto-activated):

- google/gemini-2.5-flash: conversation, explanation (cheapest)
- google/gemini-3.1-pro-preview: search, debugging
- moonshot/kimi-k2.5: code-generation (fixed: includeUsage: true)
- openai/gpt-5.4: code-gen, simple-edit, explanation, conversation, search
- deepseek/deepseek-chat: conversation

All IDs verified against live provider APIs (curl to /v1/models).
Previously: forced to anthropic/claude-sonnet-4-6 for everything (4 bugs found and fixed).

## Autonomous Run Evidence

- 40+ commits this session (35 test, 3 routing fix, 1 docs, 1 provider)
- 20+ real `storm run` subprocesses with trajectory capture
- Models used autonomously: GPT-5.4, Gemini 3.1 Pro, Gemini 2.5 Flash, Kimi K2.5
- Cost per autonomous session: $0.16-$3.12 (median ~$0.50)
- Bugs found by autonomous tests: 10+ (shell injection, silent failures, spec drift, stale model IDs, analyzer false negatives, module-load-time snapshots, private field reach-through)

## What Does NOT Exist

- No production deployment (CLI tool, not a web service)
- No monitoring, alerting, or SLOs
- No runbooks or ops documentation
- No load testing or benchmarks
- No CI/CD running on GitHub (pipeline defined but not activated)
- No multi-agent orchestration (Planner/Worker/Judge — not started)
- No SWE-bench score (eval infrastructure exists, no benchmark run)
- apps/web is gitignored and broken
- No end-to-end test of full onboard→memory→routing→agent→learning pipeline
