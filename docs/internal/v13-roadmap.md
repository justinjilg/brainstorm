# Brainstorm Enterprise — Legacy Codebase AI Infrastructure

## Context

The competitive analysis reveals a massive gap: **nobody offers a unified product that ingests a legacy codebase, generates documentation, sets up AI infrastructure, runs code reviews, and deploys AI agents to own the codebase end-to-end.** The market is fragmented across 5+ vendors (Swimm for understanding, AWS Q for transformation, Qodo for review, Devin for agents). Brainstorm already has most of the primitives — multi-model routing, 9-phase orchestration, 42+ tools, semantic search, style learning, plugin SDK. The strategy is to assemble these into a unified enterprise product.

Market size: $25B+ modernization market growing to $57B by 2030. 220B lines of COBOL still in production. 75% of enterprises already using AI for modernization.

## Design Philosophy: Natural Language First

No rigid commands. No flags. No subcommands to memorize. The user talks to Brainstorm like they talk to Claude:

```
storm "ingest this COBOL codebase and set it up for our team"
storm "review everything and find the security issues"
storm "migrate all deprecated API calls to v3"
storm "explain how the payment system works"
```

The agent loop classifies intent, selects the right pipeline, picks optimal models, and executes. Named commands (`storm analyze`, `storm docgen`) exist internally as pipeline stages but are never required. The classifier in `packages/router/src/classifier.ts` already handles code-generation, debugging, refactoring — it needs new intent types: `ingest`, `audit`, `docgen`, `migrate`, `explain-codebase`.

This is what Claude does that makes it amazing. Brainstorm does it across every model.

## The Vision: `storm ingest`

A user drops Brainstorm into their 20-year-old codebase and says:

```
storm "understand this codebase and set up AI infrastructure"
```

The agent classifies this as an ingest task and triggers a 6-phase pipeline:

### Phase 1: Deep Analysis (automated, no LLM needed)

- Parse every file (detect languages, frameworks, build systems)
- Build full dependency graph (packages, modules, functions)
- Map data flows (DB schemas, API endpoints, message queues)
- Detect patterns (design patterns, anti-patterns, dead code)
- Generate codebase statistics (size, complexity, test coverage, age per file)
- Output: `BRAINSTORM.md` with full codebase context + `analysis.json`

### Phase 2: Documentation Generation (LLM-powered)

- Architecture document (component diagram, data flow, deployment topology)
- API reference (every endpoint, every contract, every schema)
- Module-by-module documentation (purpose, dependencies, key functions)
- Onboarding guide ("how does this codebase work?")
- Risk assessment (security hotspots, complexity hotspots, test-coverage gaps)
- Output: `docs/` directory with full generated documentation

### Phase 3: AI Infrastructure Setup

- Generate `.brainstorm/` config tuned to the codebase
- Create project-specific `.agent.md` agents (domain experts per module)
- Set up BrainstormRouter routing profiles (model selection per task type)
- Configure hooks (pre-commit security scan, post-write lint, etc.)
- Wire CI/CD integration (GitHub Actions workflow for AI-assisted review)
- Output: Ready-to-use AI coding infrastructure

### Phase 4: Code Review & Technical Debt

- Full security audit (using the /full-review skill pattern)
- Technical debt inventory (categorized, prioritized, estimated effort)
- Dependency audit (outdated packages, vulnerabilities, license issues)
- Code quality baseline (complexity metrics, pattern adherence, style consistency)
- Output: Prioritized issue backlog

### Phase 5: Agent Deployment

- Deploy domain-specific agents per module (e.g., "payments-expert", "auth-expert")
- Each agent has deep context: module docs, dependency map, test patterns, coding style
- Agents can: answer questions, fix bugs, write tests, refactor, review PRs
- BrainstormRouter routes each task to the optimal model based on complexity
- Output: Working AI agents that "know" the codebase

### Phase 6: Continuous Learning

- Every agent interaction generates training data
- BrainstormLLM v2 learns the codebase's patterns over time
- Routing improves as more tasks are completed
- Documentation auto-updates as code changes
- Output: Self-improving AI infrastructure

## What Needs to Be Built

### New Packages

**`@brainstorm/ingest`** — Codebase analysis engine

- Language detection + parser integration (tree-sitter for AST analysis)
- Dependency graph builder (imports, exports, call graphs)
- Framework detector (React, Express, Django, Spring, Rails, etc.)
- Build system detector (npm, Maven, Gradle, Make, CMake, etc.)
- Database schema extractor (SQL migrations, ORM models)
- API endpoint mapper (Express routes, Spring controllers, etc.)
- Dead code detector (unreachable functions, unused exports)
- Complexity analyzer (cyclomatic complexity, cognitive complexity)
- Test coverage mapper (which code is tested, which isn't)

**`@brainstorm/docgen`** — Documentation generator

- Architecture doc generator (LLM summarizes analysis.json into prose)
- API doc generator (from endpoint map + schema extraction)
- Module doc generator (per-directory documentation)
- Onboarding guide generator (LLM writes "how to get started" from analysis)
- Risk report generator (security + complexity + coverage analysis)
- Diagram generator (Mermaid diagrams from dependency graphs)

**`@brainstorm/infra`** — AI infrastructure configurator

- Auto-generate BRAINSTORM.md from analysis
- Auto-generate .agent.md files per module
- Auto-configure routing profiles per task type
- Generate CI/CD workflows (GitHub Actions, GitLab CI)
- Generate hooks configuration (lint, security scan, test)

### New CLI Commands

```bash
# Full ingest pipeline
storm ingest --project . [--depth full|quick] [--output ./brainstorm-analysis]

# Individual phases
storm analyze                    # Phase 1 only — deterministic analysis
storm docgen                     # Phase 2 — generate documentation
storm setup-infra                # Phase 3 — configure AI infrastructure
storm audit                      # Phase 4 — code review + tech debt
storm deploy-agents              # Phase 5 — deploy domain agents

# Ongoing
storm learn                      # Phase 6 — review learning metrics
storm refresh                    # Re-run analysis on changed files
```

### Existing Packages to Extend

| Package    | Extension                                                            |
| ---------- | -------------------------------------------------------------------- |
| `core`     | Agent context builder uses analysis.json for deep codebase awareness |
| `agents`   | Auto-generated .agent.md files with module-specific system prompts   |
| `tools`    | New tools: `analyze_module`, `generate_docs`, `map_dependencies`     |
| `router`   | Project-specific routing profiles from ingest analysis               |
| `eval`     | Codebase-specific capability probes                                  |
| `workflow` | "Ingest" workflow preset                                             |

## Gap Closure — Per Competitor

### vs Aider (42K stars)

| Their Edge                                                     | Our Gap                                  | Solution                                                                                                                                                             | Sprint |
| -------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Codebase map (repo-map) for context selection                  | `repo-map.ts` exists but basic           | Enhance repo-map: full tree-sitter AST map, function signatures, class hierarchy. Feed to context builder so agent always knows the codebase structure.              | 2      |
| Architect mode (reasoning model drafts, editing model applies) | No dual-model pattern                    | Add `/architect-edit` pattern: Opus plans the change, Sonnet applies it. Wire into routing — the router already supports per-step model assignment via build wizard. | 3      |
| Auto-commit with auto-lint/test after every edit               | Hooks exist but no auto-commit-test loop | Add `auto_verify` hook preset: after every file_write/file_edit, auto-run lint+test. Already have hooks infrastructure — just ship the preset.                       | 1      |
| Token efficiency (4.2x fewer than Claude Code)                 | No token efficiency benchmarks           | Measure and publish. Brainstorm's routing should be more efficient since it picks cheaper models for simple tasks. Add `/efficiency` command showing tokens saved.   | 2      |

### vs Claude Code (dominant)

| Their Edge                             | Our Gap                                     | Solution                                                                                                                                  | Sprint |
| -------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Computer Use (browser GUI automation)  | Web fetch/search only                       | Integrate Playwright MCP server as first-party. `storm browser` command. Already have MCP client package.                                 | 2      |
| `/loop` background scheduled tasks     | No background loop                          | Add `storm loop` command: run a prompt or slash command on interval. Already have scheduler package — extend it for foreground loop mode. | 1      |
| OS-level sandbox (Seatbelt/Bubblewrap) | Docker-only sandbox                         | Add macOS Seatbelt profile + Linux seccomp/Bubblewrap. Ship as default sandbox — Docker becomes optional heavy mode.                      | 1      |
| Voice mode                             | Voice recorder exists but not wired         | Wire `packages/cli/src/voice/recorder.ts` to Whisper API via BrainstormRouter. `/voice` slash command to toggle.                          | 4      |
| Memory (CLAUDE.md per project)         | Already have BRAINSTORM.md + 4 memory types | Already ahead here. Enhance with `storm memory` command to view/manage.                                                                   | 1      |

### vs Codex CLI (68K stars)

| Their Edge                         | Our Gap                    | Solution                                                                                                                             | Sprint |
| ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Rust-based (instant startup)       | Node.js startup ~500ms     | Add `--fast` mode that skips provider discovery + DB init on startup. Lazy-load heavy packages. Target <200ms cold start.            | 3      |
| Zero-network sandbox default       | Network allowed by default | Change default sandbox from `restricted` to `restricted-no-network`. Opt-in network with `--network` flag.                           | 1      |
| Python SDK for programmatic access | No programmatic SDK        | Ship `@brainstorm/sdk` — thin wrapper that exposes `runAgent()`, `classifyTask()`, `routeModel()` as a library. CLI imports from it. | 4      |

### vs Cline/Roo Code (60K/23K stars)

| Their Edge                                | Our Gap                         | Solution                                                                                                                                                            | Sprint |
| ----------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| VS Code extension (IDE-native)            | CLI only                        | Ship `@brainstorm/vscode` — chat sidebar, inline edit suggestions, model selection palette. Keep CLI as primary.                                                    | 5      |
| Custom Modes (personas with scoped tools) | Roles exist but no tool scoping | Extend roles to include `allowedTools` and `blockedTools`. Already have permission system — just wire it to role definitions.                                       | 2      |
| Plan/Act toggle                           | No explicit plan mode toggle    | Add `/plan` toggle: when active, agent describes changes before making them. User approves, then agent executes. Already have plan executor — add interactive mode. | 2      |

### vs OpenHands (70K stars)

| Their Edge                          | Our Gap                      | Solution                                                                                                                          | Sprint |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Cloud-scale parallel agents (1000s) | Local only                   | Add `storm cloud` via BrainstormRouter. BR spawns remote agents in containers. Pay-per-use. Local CLI dispatches, cloud executes. | 5      |
| SWE-bench SOTA                      | Not benchmarked              | Run SWE-bench Verified. Publish results. Use 9-phase pipeline with heterogeneous routing for best scores.                         | 1      |
| Docker isolation by default         | Docker optional, not default | Already have Docker sandbox. Make it easier: `storm sandbox enable` one-time setup.                                               | 1      |

### vs Goose (34K stars)

| Their Edge                         | Our Gap                      | Solution                                                                                                                                                                   | Sprint |
| ---------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1,700+ MCP extensions              | Tiny MCP ecosystem           | Ship 10 first-party MCP servers (Slack, Linear, Jira, Notion, Datadog, Vercel, AWS, Supabase, Stripe, GitHub advanced). Create template + registry.                        | 3-5    |
| Recipes (shareable YAML workflows) | No shareable workflow format | Add `.brainstorm/recipes/` — YAML workflow definitions sharable via git. Already have workflow engine + 4 presets. Add `storm recipe run <name>` and `storm recipe share`. | 3      |
| Linux Foundation backing           | No foundation backing        | Not actionable short-term. Focus on adoption first.                                                                                                                        | —      |

### vs Cursor/Windsurf (closed, dominant IDEs)

| Their Edge                         | Our Gap                             | Solution                                                                                                                                            | Sprint |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Background agents (parallel tasks) | Sequential only                     | Add `storm spawn "task"` — background agent in worktree. Already have worktree support in `speculative.ts`. Extend to user-facing background tasks. | 4      |
| Composer (multi-file editing UI)   | Multi-file edit exists but CLI only | VS Code extension will address this. For CLI, add `storm edit "change X across all files matching Y"` batch command.                                | 5      |
| Auto model selection ("auto mode") | Already have this — 6 strategies    | Already ahead. Market it better. Add `storm route explain` showing why a model was chosen.                                                          | 2      |

### vs Amp (Sourcegraph)

| Their Edge                                 | Our Gap                 | Solution                                                                                                                        | Sprint |
| ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Cross-repo code search (all public GitHub) | Single-repo only        | Add `storm search --global "pattern"` using Sourcegraph API or GitHub code search API. Combine with local semantic search.      | 4      |
| Librarian subagent for remote code         | No remote code subagent | Add `research` subagent type that searches external repos, docs, Stack Overflow. Wire to web_search + GitHub API tools.         | 3      |
| Team shared threads/workflows              | Single-user only        | BrainstormRouter shared routing intelligence already covers model learning. Add `storm share` to export/import session context. | 5      |

## Implementation Order (flywheel-first)

Every item shows its flywheel connection: how it generates data that makes the system smarter.

### Sprint 1 (2 weeks): Ship + Secure + Benchmark

| #   | Item                                                       | Closes Gap vs          | Flywheel Connection                                                                                           |
| --- | ---------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | npm publish `@brainstorm/cli`                              | All (distribution)     | More users → more routing data → better Thompson sampling                                                     |
| 2   | OS-level sandbox (Seatbelt + seccomp)                      | Claude Code, Codex CLI | Safer execution → users trust unattended mode → more trajectories                                             |
| 3   | Default sandbox to restricted-no-network                   | Codex CLI              | Same as above                                                                                                 |
| 4   | SWE-bench Verified benchmarking                            | OpenHands              | Benchmark runs = trajectories. Results identify routing weaknesses → targeted improvement                     |
| 5   | `auto_verify` hook preset (lint+test after edits)          | Aider                  | Every verify result is a binary outcome signal → Thompson learns which models write code that compiles/passes |
| 6   | `storm loop` command (scheduled prompt on interval)        | Claude Code `/loop`    | Continuous background execution = continuous trajectory generation                                            |
| 7   | `storm memory` command (view/manage)                       | Claude Code            | Memory visibility → users curate better context → better agent performance → better outcomes                  |
| 8   | `@brainstorm/ingest` skeleton + lang detection + dep graph | Swimm, nobody (unique) | Codebase analysis → project-specific routing profiles → routing decisions tuned from first interaction        |

### Sprint 2 (2 weeks): Analysis Engine + Context Intelligence

| #   | Item                                                    | Closes Gap vs                   | Flywheel Connection                                                                                           |
| --- | ------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 9   | Enhanced repo-map (tree-sitter AST, function/class map) | Aider                           | Better context selection → fewer wasted tokens → cost data improves → routing learns token-efficient patterns |
| 10  | Playwright MCP browser integration                      | Claude Code Computer Use, Cline | Browser tool calls = new tool type in trajectory data → BR learns which models handle browser tasks best      |
| 11  | `/plan` toggle mode (describe before execute)           | Cline Plan/Act                  | Planning quality captured → trains BrainstormLLM phase-skip predictor on which plans succeed                  |
| 12  | Role tool scoping (`allowedTools`/`blockedTools`)       | Roo Code Custom Modes           | Scoped roles = cleaner trajectories per domain → routing learns per-domain model preferences                  |
| 13  | `storm route explain` (why this model was chosen)       | Cursor auto mode                | Transparency → user overrides when wrong → override signal trains routing                                     |
| 14  | Token efficiency measurement + `/efficiency`            | Aider                           | Measures the flywheel's cost savings directly. Publishing numbers drives adoption.                            |
| 15  | Framework + build system detection in ingest            | Swimm                           | Detected framework → routing profiles → "Spring apps route to model X" learned over time                      |
| 16  | API endpoint mapping in ingest                          | Nobody                          | Endpoint map → agents know the API surface → better task decomposition → better trajectories                  |
| 17  | `storm analyze` command                                 | Nobody (unique)                 | Every analysis generates a codebase profile that seeds the routing flywheel for that project                  |

### Sprint 3 (2 weeks): Docs + Recipes + Dual-Model

| #   | Item                                                                | Closes Gap vs   | Flywheel Connection                                                                                              |
| --- | ------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| 18  | Recipes (shareable YAML workflows)                                  | Goose           | Shared recipes = same workflow across users → BrainstormLLM sees repeated patterns → learns optimal phase config |
| 19  | `research` subagent type (external search)                          | Amp Librarian   | External search results correlated with outcomes → BR learns which sources produce successful code               |
| 20  | 5 first-party MCP servers (Slack, Linear, GitHub, Vercel, Supabase) | Goose (1700+)   | Each MCP tool call is a routing decision + outcome → BR learns model-tool affinity                               |
| 21  | `/architect-edit` dual-model (Opus plans, Sonnet applies)           | Aider Architect | Two routing decisions per task → 2x trajectory data. Explicit plan→edit separation trains phase predictor        |
| 22  | Architecture doc generator                                          | Swimm           | Doc generation runs through 9-phase pipeline → trajectories. Generated docs improve future agent context         |
| 23  | Module doc generator                                                | Nobody          | Same as above. Module docs become agent system prompts → better agent performance                                |
| 24  | API doc generator + Mermaid diagrams                                | Nobody          | Diagrams = structured codebase knowledge → feeds into repo-map → better context → better outcomes                |
| 25  | `storm docgen` command                                              | Nobody (unique) | Massive trajectory generation — docgen for 50 modules = 50+ pipeline runs = 50+ training examples                |

### Sprint 4 (2 weeks): Background Agents + Unattended Mode (Stripe Pattern)

| #   | Item                                            | Closes Gap vs                | Flywheel Connection                                                                                       |
| --- | ----------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| 26  | `storm spawn "task"` background worktree agents | Cursor Background Agents     | Parallel agents = parallel trajectories = volume multiplier for learning                                  |
| 27  | `storm run --unattended` one-shot PR mode       | Stripe Minions               | Highest-volume trajectory source: 1 unattended run = 10+ tool calls = 10+ outcome signals                 |
| 28  | Task queue (`storm queue add "t1" "t2" "t3"`)   | Stripe Minions (1300 PRs/wk) | Queue of N tasks = N parallel trajectories. This is the Stripe flywheel at scale                          |
| 29  | `storm search --global` cross-repo search       | Amp/Sourcegraph              | Cross-repo context → agents make better decisions → better outcomes → routing improves                    |
| 30  | `--fast` startup mode (<200ms)                  | Codex CLI                    | Faster startup → more casual usage → more sessions → more data                                            |
| 31  | `@brainstorm/sdk` programmatic library          | Codex CLI Python SDK         | SDK enables CI/CD integration → unattended pipeline runs → continuous trajectory flow                     |
| 32  | `/voice` command (Whisper via BR)               | Claude Code voice            | Voice input → routing decision (Whisper model selection) → outcome tracking                               |
| 33  | Auto-generate BRAINSTORM.md from analysis       | Nobody (unique)              | Generated context = pre-seeded routing profiles. Every project starts with good routing from day 1        |
| 34  | Auto-generate .agent.md per module              | Nobody (unique)              | Domain agents = domain-specific trajectories. "auth-expert" agent generates auth-specific routing data    |
| 35  | `storm setup-infra` command                     | Nobody (unique)              | Infrastructure setup = walls (Stripe concept). Better walls → better constrained agents → better outcomes |

### Sprint 5 (2 weeks): IDE + Cloud + Enterprise

| #   | Item                                                    | Closes Gap vs                     | Flywheel Connection                                                                            |
| --- | ------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| 36  | `@brainstorm/vscode` extension                          | Cline, Cursor, Windsurf           | Same flywheel, new entry point. IDE users generate same trajectories + routing data            |
| 37  | `storm cloud` remote agents via BR                      | OpenHands (1000s agents)          | Cloud agents = unlimited parallel trajectory generation. Pay-per-use = BR revenue              |
| 38  | 5 more MCP servers (Jira, Notion, Datadog, AWS, Stripe) | Goose                             | More tool types → richer trajectories → BR learns model-tool affinity across more integrations |
| 39  | `storm share` export/import session context             | Amp team threads                  | Shared sessions → team routing intelligence. N users learning = N× faster flywheel             |
| 40  | Enterprise SSO via BR OAuth                             | Cline Enterprise, Cursor Business | Enterprise = high-volume users. 100 devs × 20 tasks/day = 2000 trajectories/day per customer   |
| 41  | `storm ingest` unified pipeline                         | Nobody (unique)                   | Ingestion = 1000s of analysis tasks per codebase = massive one-time trajectory injection       |
| 42  | `storm audit` (/full-review for external codebases)     | Nobody (unique)                   | Every audit finding → trajectory. Audit of 100-file codebase = 100+ data points                |
| 43  | CI/CD workflow generation (GitHub Actions, GitLab CI)   | Nobody                            | CI-triggered agents = unattended runs on every push = continuous trajectory stream             |

## The Flywheel Acceleration Curve

```
Sprint 1: ~10 trajectories/day (manual usage, single user)
Sprint 2: ~50/day (better context → more effective sessions → users do more)
Sprint 3: ~200/day (docgen generates 50+ per codebase, recipes multiply usage)
Sprint 4: ~1000/day (unattended mode, task queues, background agents)
Sprint 5: ~10000/day (cloud agents, enterprise teams, CI/CD integration)
```

Each 10x increase in trajectory volume makes BrainstormLLM v2 materially smarter. By Sprint 5, the routing intelligence should be measurably better than any single-model tool — not because of a better model, but because of better data.

## Competitive Positioning

**Tagline:** "Drop Brainstorm into any codebase. Get AI infrastructure in minutes."

| Competitor      | What They Do              | What Brainstorm Does Better                                |
| --------------- | ------------------------- | ---------------------------------------------------------- |
| Swimm           | Understand code           | Understand + document + set up infra + deploy agents       |
| AWS Q Transform | Modernize mainframe       | Cloud-agnostic, any language, any framework                |
| Qodo            | Code review               | Review + routing + orchestration + learning                |
| Devin           | AI agents for modern code | Agents + legacy understanding + multi-model routing        |
| Sourcegraph/Amp | Code search + agents      | Ingest pipeline + infrastructure setup + cost optimization |

## Verification

1. Test `storm ingest` on brainstorm's own codebase (meta-test)
2. Test on a real legacy project (peer10 — TypeScript, 2 years)
3. Test on a larger legacy project (brainstormmsp — Python/FastAPI)
4. Measure: time to ingest, doc quality, agent accuracy, cost
5. Benchmark against Swimm + Qodo combo (the closest competitor pair)
