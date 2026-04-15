# Assessment Evidence — Brainstorm Platform

Generated: 2026-04-15T09:12:31Z

## 1. Code Inventory

### Package Line Counts (src only, .ts/.tsx)

| Package               | Src Files | Src Lines   | Test Files | Test Lines |
| --------------------- | --------- | ----------- | ---------- | ---------- |
| packages/agents       | 9         | 1,102       | 3          | 357        |
| packages/cli          | 45        | 17,471      | 17         | 2,576      |
| packages/code-graph   | 46        | 6,402       | 7          | 1,629      |
| packages/config       | 6         | 889         | 2          | 472        |
| packages/core         | 122       | 24,793      | 30         | 7,010      |
| packages/db           | 5         | 2,462       | 3          | 617        |
| packages/docgen       | 5         | 926         | 3          | 721        |
| packages/eval         | 14        | 1,738       | 5          | 816        |
| packages/gateway      | 7         | 1,086       | 3          | 869        |
| packages/godmode      | 40        | 5,404       | 8          | 1,730      |
| packages/hooks        | 7         | 857         | 3          | 840        |
| packages/ingest       | 7         | 1,390       | 3          | 311        |
| packages/mcp          | 4         | 404         | 3          | 598        |
| packages/onboard      | 18        | 2,994       | 3          | 642        |
| packages/orchestrator | 4         | 641         | 3          | 882        |
| packages/plugin-sdk   | 4         | 344         | 1          | 285        |
| packages/projects     | 4         | 576         | 2          | 384        |
| packages/providers    | 9         | 1,177       | 2          | 274        |
| packages/router       | 17        | 2,580       | 6          | 1,491      |
| packages/scheduler    | 5         | 693         | 3          | 290        |
| packages/sdk          | 1         | 217         | 1          | 371        |
| packages/server       | 5         | 1,648       | 2          | 273        |
| packages/shared       | 9         | 1,225       | 4          | 602        |
| packages/tools        | 61        | 7,588       | 7          | 1,325      |
| packages/vault        | 7         | 585         | 4          | 763        |
| packages/vscode       | 3         | 326         | 1          | 32         |
| packages/workflow     | 8         | 1,498       | 3          | 582        |
| apps/cli              | 1         | 104         | 0          | 0          |
| apps/desktop          | 34        | 8,748       | 0          | 0          |
| apps/web              | 59        | 7,787       | 0          | 0          |
| **TOTAL**             | **566**   | **103,655** | **132**    | **26,742** |

## 2. Test Results

```
The latest test that might've caused the error is "updates local entry when remote is newer by timestamp". It might mean one of the following:
- The error was thrown, while Vitest was running this test.
- If the error occurred after the test had been completed, this was the last documented test before it was thrown.

⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
Error: ENOENT: no such file or directory, open '/Users/justin/.brainstorm/projects/75208bfb192287bd/memory/MEMORY.md'
 ❯ writeFileSync node:fs:2437:20
 ❯ MemoryManager.flushIndex packages/core/src/memory/manager.ts:870:5
    868|     }
    869|
    870|     writeFileSync(this.indexPath, lines.join("\n") + "\n", "utf-8");
       |     ^
    871|   }
    872|
 ❯ Timeout._onTimeout packages/core/src/memory/manager.ts:831:12
 ❯ listOnTimeout node:internal/timers:588:17
 ❯ processTimers node:internal/timers:523:7

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯
Serialized Error: { errno: -2, code: 'ENOENT', syscall: 'open', path: '/Users/justin/.brainstorm/projects/75208bfb192287bd/memory/MEMORY.md' }
This error originated in "packages/core/src/__tests__/memory-manager.test.ts" test file. It doesn't mean the error was thrown inside the file itself, but while it was running.
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯


 Test Files  17 failed | 139 passed | 1 skipped (157)
      Tests  29 failed | 1766 passed | 21 skipped (1816)
     Errors  27 errors
   Start at  05:12:54
   Duration  46.72s (transform 5.05s, setup 0ms, collect 53.07s, tests 125.19s, environment 24ms, prepare 15.28s)

```

## 3. Build Status

```
 Tasks:    0 successful, 5 total
Cached:    0 cached, 5 total
  Time:    1.157s
Failed:    brainstorm-cli#build
```

## 4. Git Log (last 20 commits)

```
4789e40 fix(codebase-audit): end-to-end loop works + findings fix command
a8b12da feat(codebase-audit): fleet-agent documentation with findings CLI
99a0b43 feat(findings): structured audit findings on top of MemoryManager
f925e3a feat(memory): pullFromGateway — bidirectional sync with last-writer-wins
81d1bbe feat(gateway+cli): memory init/shared/pending + sync queue CLI
d7dad47 feat(sync): retry queue + SyncWorker for fire-and-forget BR pushes
2f9defe docs: BR capability audit — 587 endpoints inventoried, 3% wired
e03ff71 chore: refresh onboard outputs from Dogfood #1 run
670ea10 fix(multi-agent): safety preamble + unauthorized dep-change detection
4bbe9d3 fix: 5 bugs from Dogfood #1 — silent exit, frontmatter, memory, budget, quality-signals
83f52cd fix(multi-agent): planner no-tools directive + Dogfood #2 evidence
3516e0c feat(cli): brainstorm orchestrate parallel — Planner/Worker/Judge driver
7544b9b feat(multi-agent): Planner + Worker Pool + Judge runtime
a9ba80b feat(orchestrator): worker-pool primitives for multi-agent orchestration
7c92d37 feat(onboard): build code graph as a dedicated pipeline phase
0887319 fix(code-graph): parse generator functions, recover module-level call sites
7dd9156 feat(learning-loop): cost-adjusted ranking + Wilson bound + capability bias
07cec8b fix(core): normalize mid-stream system messages for Gemini compatibility
b5f844d feat(kairos): first dogfood run — 6 passing tests, 5 bugs surfaced
3d1a17c fix(eval): widen instruction-adherence verification to accept refusal phrasing
```

## 5. New Files This Session (unstaged)

```
 M apps/desktop/electron/main.ts
 M apps/desktop/src/lib/ipc-client.ts
 D apps/desktop/test-results/.last-run.json
 M docs/assessment-evidence.md
 M package-lock.json
 M packages/cli/src/bin/brainstorm.ts
 M packages/cli/src/init/templates.ts
 M packages/cli/src/mcp-server.ts
 M packages/code-graph/package.json
 M packages/code-graph/src/__tests__/code-graph.test.ts
 M packages/code-graph/src/graph.ts
 M packages/code-graph/src/index.ts
 M packages/code-graph/src/indexer.ts
 M packages/code-graph/src/parser.ts
 M packages/code-graph/tsup.config.ts
 M packages/config/src/schema.ts
 M packages/core/src/agent/loop.ts
 M packages/core/src/agent/subagent-tool.ts
 M packages/core/src/agent/subagent.ts
 M packages/core/src/index.ts
 M packages/core/src/memory/git.ts
 M packages/core/src/memory/manager.ts
 M packages/core/src/middleware/index.ts
 M packages/db/src/client.ts
 M packages/db/src/index.ts
 M packages/docgen/src/index.ts
 M packages/godmode/src/changeset.ts
 M packages/godmode/src/index.ts
 M packages/godmode/src/types.ts
 M packages/hooks/src/index.ts
 M packages/hooks/src/manager.ts
 M packages/hooks/src/types.ts
 M packages/router/src/index.ts
 M packages/vault/src/backends/op-cli.ts
?? ARCHITECTURE_DIAGRAM.txt
?? WORK-PLAN.md
?? analyze_deps.py
?? apps/cli/
?? apps/desktop/release/
?? apps/desktop/test-results/.playwright-artifacts-5/
?? apps/desktop/test-results/app-Navigator-KAIROS-widget-navigates-to-config/
?? apps/desktop/test-results/app-Status-Rail-permission-mode-is-displayed/
?? "apps/desktop/test-results/data-flow-Data-Flow-\342\200\224-Mock-5af01-ls-POST-and-shows-scorecard/"
?? apps/desktop/test-results/error-states-Error-States--332e9-connected-banner-disappears/
?? "apps/desktop/test-results/journeys-E2E-Journeys-\342\200\224-Co-8e86c-re-every-view-without-crash/"
?? "apps/desktop/test-results/journeys-E2E-Journeys-\342\200\224-Co-f871c-s-from-3-different-UI-paths/"
?? "apps/desktop/test-results/no-server-No-Server-\342\200\224-ever-8be13--view-renders-without-crash/"
?? arch_diagram.txt
?? brainstorm-vault/
?? debounce.ts
?? docs/kairos-runs/03-codebase-audit/
?? eval-data/swe-bench-pilot-3.jsonl
?? eval-data/swe-bench-pytest5.jsonl
?? eval-data/swe-bench-unique-14.jsonl
?? flatten.ts
?? groupby.ts
?? merge.js
?? packages/cli/src/init/org-init.ts
?? packages/code-graph/src/__tests__/cross-project.test.ts
?? packages/code-graph/src/__tests__/graph-enhanced.test.ts
```

## 6. Wiring Audit — Are new features connected to entrypoints?

### Code Intelligence MCP (16 tools)

packages/cli/src/mcp-server.ts
packages/code-graph/src/mcp/tools.ts
packages/code-graph/src/mcp/index.ts
packages/code-graph/src/mcp/server.ts

### Governance MCP (6 tools)

packages/cli/src/mcp-server.ts
packages/core/src/traceability/mcp-tools.ts
packages/core/src/traceability/index.ts
packages/core/src/index.ts

### GitHub Connector

packages/godmode/src/connectors/github/index.ts
packages/godmode/src/index.ts
packages/cli/src/init/org-init.ts

### Sector Daemon Integration

packages/cli/src/bin/brainstorm.ts

### Secret Substitution Middleware

packages/core/src/middleware/index.ts

### Tool Name Adapter

packages/core/src/agent/loop.ts

### Traceability

packages/core/src/traceability/validate.ts
packages/core/src/traceability/mcp-tools.ts
packages/core/src/traceability/index.ts
packages/core/src/traceability/store.ts

### Org Init

packages/cli/src/init/org-init.ts

## 7. Test File Audit — Integration vs Mock

### Real I/O tests (create temp dirs, write files, run SQLite)

packages/code-graph/src/**tests**/code-graph.test.ts
packages/code-graph/src/**tests**/cross-project.test.ts
packages/code-graph/src/**tests**/graph-enhanced.test.ts
packages/code-graph/src/**tests**/languages.test.ts
packages/code-graph/src/**tests**/mcp-tools.test.ts
packages/code-graph/src/**tests**/pipeline.test.ts
packages/code-graph/src/**tests**/sectors.test.ts
packages/core/src/**tests**/codebase-audit.test.ts
packages/core/src/**tests**/curator-runner.test.ts
packages/core/src/**tests**/e2e-pipeline.test.ts
packages/core/src/**tests**/findings.test.ts
packages/core/src/**tests**/git-sync.test.ts
packages/core/src/**tests**/kairos-integration.test.ts
packages/core/src/**tests**/memory-manager.test.ts
packages/core/src/**tests**/multi-agent-worker-pool.test.ts
packages/core/src/**tests**/property-tests.test.ts
packages/core/src/**tests**/traceability.test.ts
packages/core/src/**tests**/trajectory-analyzer.test.ts

### Mock-only tests

packages/core/src/**tests**/curator-runner.test.ts
packages/core/src/**tests**/e2e-pipeline.test.ts
packages/core/src/**tests**/quality-signals.test.ts

## 8. Package Import Map — Orphan Detection

### Packages imported by @brainst0rm/cli (the main entrypoint)

@brainst0rm/agents
@brainst0rm/config
@brainst0rm/core
@brainst0rm/db
@brainst0rm/eval
@brainst0rm/gateway
@brainst0rm/mcp
@brainst0rm/providers
@brainst0rm/router
@brainst0rm/shared
@brainst0rm/tools
@brainst0rm/vault
@brainst0rm/workflow
