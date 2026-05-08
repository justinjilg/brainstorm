# Code Graph Multi-Modal Extension & PreToolUse Wiring

**Status:** Planned
**Owner:** JJ + Claude
**Created:** 2026-04-21
**Motivation:** Integrate Graphify's PreToolUse pattern into storm CLI and extend `packages/code-graph` to index docs, papers, and images alongside code. Ship the governed-channel equivalent of Graphify's approach.

## Context

Graphify ships an always-on PreToolUse hook that injects a knowledge-graph summary before every Glob/Grep call in Claude Code. Claim: 71.5× token reduction on architecture queries. The one genuinely excellent design decision in their tool is the hook itself — without it, code-graph tools die on adoption because the model forgets to consult them.

### What we already have

- `packages/code-graph` — SQLite-backed structural graph. Tree-sitter AST parsing. TypeScript-heavy with language adapter system for Python/Go/Rust/Java. Community detection via Leiden. Sector-based codebase partitioning. MCP tool surface. Pipeline DAG. Hybrid BM25+graph search.
- `packages/hooks/src/builtin/graph-enrich.ts` — **The PreToolUse hook already exists.** Matches on `grep|glob|file_read|code_search`. Exported from the package index. **Never registered anywhere.** Dead code waiting for wiring.
- `packages/hooks` — full lifecycle hook manager with `PreToolUse`, `PostToolUse`, `SessionStart`, etc. Mirrors Claude Code's event model.
- BrainstormRouter — governance + audit + budget enforcement for every LLM call. Any paper/image extraction routes through it automatically.

### Gap

- The existing graph-enrich hook isn't wired into session startup.
- `packages/code-graph` is code-only. No docs/papers/images.
- No external Claude Code plugin surface — users of vanilla Claude Code can't install our graph.

## Non-goals

- **Video/audio ingest.** Graphify does this via faster-whisper; unclear any Brainstorm user asks for it. Defer until a real request arrives.
- **Leiden clustering on semantic (non-code) concepts.** Existing community detection works on code topology. Extending to papers/images without a clear query-win case is premature.
- **Auto-install into arbitrary user configs.** Any hook that writes to `~/.claude/settings.json` must be opt-in per project, never global without explicit authorization.

## Design principles

1. **Single source of truth.** Extend `packages/code-graph` in-place. Do not create a parallel `packages/knowledge-graph`. Name stability > categorical neatness.
2. **Cross-type edges by default.** Docs can link to code; papers can implement code; images can depict code. Node types differ (`CodeNode`, `DocNode`, `ConceptNode`, `ImageNode`); the edge table is unified.
3. **Governance first.** All LLM extraction routes through BrainstormRouter. PII stripping + budget enforcement + audit trail are automatic benefits, not add-ons.
4. **Deterministic where possible.** Tree-sitter for code, heading-parsing for docs, XML-parsing for SVG. LLM calls reserved for PDF concept extraction and image vision. Cache aggressively on content SHA256 + prompt version.
5. **Token-budget-aware.** Injected graph context capped per query (target <1.5k for code, <2k for cross-modal).

## Phase 0 — Wire the existing hook

**Effort:** 1–2 days
**Risk:** Low
**Goal:** `createGraphEnrichHooks` registers by default on every storm session.

**Scope:**

- In `packages/core` session startup, import and register the hook with a real `getContext` implementation backed by `CodeGraph`.
- Opt-out via `brainstorm.toml`: `[hooks.graph-enrich] enabled = false`.
- Query resolution:
  - glob pattern → matching files → sectors + community summary
  - grep pattern → symbol lookup → callers + callees (depth 1, capped at 10)
  - file_read path → file's sector summary + direct graph neighbors
- Injected-context token budget: hard cap at 1.5k. Truncate by centrality (keep top-N highest-degree nodes).
- Hook latency budget: p95 <50ms for code queries. Log and warn if exceeded.

**Deliverables:**

- PR wiring `createGraphEnrichHooks` into session startup.
- Default-on for projects with an indexed graph; default-off if no graph exists.
- Config flag documented in `packages/core/README.md` and `docs/config-guide.md`.

**Acceptance:**

- Every storm session emits a `[graph-enrich]` hook firing before the first Glob/Grep/Read.
- Existing code-graph test suite still passes.
- New test: session without graph index does not error, silently skips.

## Phase 1 — Docs ingest

**Effort:** 3–5 days
**Risk:** Low
**Goal:** markdown, mdx, rst, txt live in the same graph as code.

**Scope:**

- New module `packages/code-graph/src/multimodal/docs.ts`.
- Extract deterministically — no LLM:
  - headings → `DocNode` (heading text, depth, file path)
  - internal links `[text](./path)` → `LINKS_TO` edges
  - fenced code blocks → `CONTAINS_CODE` edges, cross-linked to existing `FunctionDef`/`ClassDef` nodes by symbol resolution
  - front-matter (YAML/TOML) → node metadata
- Run on same `indexProject()` pass. SHA256 cache on file content.
- New MCP tool: `doc_search(query) → {path, heading, snippet, linked_symbols[]}`.
- New SQLite tables (or extend existing): `doc_nodes`, `doc_edges`.

**Deliverables:**

- `docs.ts` module + unit tests.
- SQLite migration for new tables.
- MCP tool registered.
- README in `packages/code-graph/` updated with doc ingest section.

**Acceptance:**

- Indexing a project with READMEs and architecture docs produces doc nodes.
- `doc_search("authentication")` returns doc sections _with_ linked symbol references.
- Re-indexing is no-op on unchanged files.

## Phase 2 — Paper ingest

**Effort:** 4–6 days
**Risk:** Medium (LLM cost)
**Goal:** PDFs become queryable concepts with edges to code that implements them.

**Scope:**

- New module `packages/code-graph/src/multimodal/papers.ts`.
- PDF extraction via `pdfjs-dist` (pure JS, no native deps, keeps the package install-clean).
- Semantic chunking: ~500–1000 tokens per chunk, preserve section boundaries.
- For each chunk, call extraction prompt via BrainstormRouter. Expected return:
  ```json
  {
    "concepts": ["Thompson sampling", "UCB1", "bandit"],
    "relations": [["Thompson sampling", "is_a", "bandit"]],
    "references": ["Lattimore & Szepesvári 2020"]
  }
  ```
- Store as `ConceptNode` / `PaperNode`. Edges: `MENTIONS`, `CITES`, `IMPLEMENTS` (paper concept ↔ code symbol by fuzzy name match).
- Cache: SHA256 of `(pdf_bytes, extraction_prompt_version)`. Re-extract only on change.
- **Opt-in per project.** Paper ingest off by default. Enabled via manifest flag or explicit `storm graph ingest --papers`.
- Budget guard: estimate tokens before extraction, block if projected cost exceeds configured ceiling (default $5). User must `--confirm` to proceed.

**Deliverables:**

- `papers.ts` module + unit tests with mocked PDF extraction.
- Migration for `paper_nodes`, `concept_nodes`, cross-type edges.
- CLI command `storm graph ingest --papers [paths...]`.
- Budget-guard tested against a mock BR pricing response.

**Acceptance:**

- Ingesting Codebase-Memory paper produces concept nodes linked to our `CodeGraph` class via `IMPLEMENTS` edges (fuzzy name match demonstrated).
- Re-ingest same PDF: zero LLM calls.
- Ingest on a 10-paper corpus without `--confirm` halts with cost estimate; with `--confirm` proceeds.

## Phase 3 — Image ingest

**Effort:** 3–5 days
**Risk:** Medium (vision cost)
**Goal:** whiteboard photos, architecture diagrams, PNG screenshots become addressable graph nodes.

**Scope:**

- New module `packages/code-graph/src/multimodal/images.ts`.
- Per image: Claude vision call (routed via BR) → structured JSON:
  ```json
  {
    "labeled_entities": ["api-gateway", "auth-service", "db"],
    "relations": [["api-gateway", "calls", "auth-service"]],
    "architectural_role": "request-flow diagram"
  }
  ```
- Same node/edge types as papers: `ConceptNode` + relations, `ImageNode` with file path + SHA256.
- **SVG special case:** parse as XML first, extract text labels deterministically, skip LLM entirely. Much cheaper.
- Cache on `(image_sha256, vision_prompt_version)`.
- Opt-in per project, same budget guard as Phase 2.

**Deliverables:**

- `images.ts` module + unit tests (mock vision for tests, real vision in integration tests).
- SVG deterministic path (no LLM) for diagrams exported from draw.io/excalidraw/mermaid.
- CLI command `storm graph ingest --images [paths...]`.

**Acceptance:**

- Ingesting an architecture diagram produces concept nodes with `calls`/`depends_on`/`contains` relations.
- SVG path does not make any LLM call.
- Budget guard behaves identically to Phase 2.

## Phase 4 — Cross-modal retrieval

**Effort:** 2–3 days
**Risk:** Low
**Goal:** one query surface across code + docs + papers + images.

**Scope:**

- New MCP tool: `multimodal_search(query, modes=['code','docs','papers','images'])`.
- Ranking algorithm:
  1. BM25 on text content of every node type (existing `hybridSearch` already covers code).
  2. Graph centrality boost for nodes 1 hop from any BM25 hit.
  3. Type-priority: `code > docs > concepts > images` (configurable) to tie-break.
- Result shape: `{nodeType, nodeId, snippet, score, related_nodes}`.
- Extend `packages/code-graph/src/search/` — minimal new code, mostly composition of existing primitives.

**Deliverables:**

- `multimodal_search` MCP tool.
- Performance test: cross-modal query on the brainstorm repo returns in <500ms p95.

**Acceptance:**

- A single `multimodal_search` call returns the code + doc + concept + image results that previously took 3–5 grep/glob cycles.
- Ranking is stable across runs on unchanged data.

## Phase 5 — External Claude Code plugin (optional)

**Effort:** 2–3 days
**Risk:** Low
**Goal:** users of vanilla Claude Code install our graph + hook without adopting storm CLI.

**Scope:**

- New `apps/claude-code-plugin/` or `packages/plugin-claude-code-graph/`.
- Claude Code plugin manifest + PreToolUse hook registration.
- Hook: command-type, runs `storm graph context --json <query>` as a shell command. Output injected as context.
- `CLAUDE.md` section written automatically on install: advises agent to consult graph output before architecture questions.
- Install flow: `storm plugin install claude-code-graph` in a project directory. **Never writes to `~/.claude/settings.json` globally.** Always project-scoped.
- Uninstall: `storm plugin uninstall claude-code-graph` removes the hook entry.

**Deliverables:**

- Plugin package + install/uninstall commands.
- Docs: "How to install Brainstorm's code graph in Claude Code."
- Distribution path via the official Claude Code plugin registry if possible.

**Acceptance:**

- Fresh Claude Code session in a plugin-installed project shows graph context injected before first Glob.
- Uninstall leaves no traces in `.claude/` files.

## Phase 6 — Validation & benchmark

**Effort:** 1 week
**Risk:** Low
**Goal:** prove the compression ratio with real numbers. No marketing claims.

**Scope:**

- Benchmark harness in `packages/code-graph/src/bench/`.
- Fixed query set (~25 queries) against the brainstorm monorepo itself, with and without the hook.
- Categories: architecture queries, symbol lookups, bug-fix queries, cross-modal queries.
- Metrics:
  - Tokens injected per query (target <2k)
  - Tokens equivalent via raw Glob+Grep+Read baseline
  - Compression ratio per category
  - Hook p95 latency (target <50ms code, <500ms cross-modal)
  - Answer quality delta (LLM-judge on final responses; sampled)
- Output: `packages/code-graph/BENCHMARK.md` + blog post draft for brainstorm.co.

**Deliverables:**

- Harness + query set + results table.
- Honest comparison to Graphify's 71.5× claim on similar corpora.

**Acceptance:**

- Results are reproducible by running `npm run bench -- --full`.
- README is updated with concrete numbers, not handwaves.

## Integration with Brainstorm thesis

- All LLM extraction routes through **BrainstormRouter** → governance, audit, budget enforcement, PII stripping come free.
- Every extraction becomes a **trajectory** → feeds **BrainstormLLM** training data.
- The PreToolUse hook becomes a **guardrail attachment point** — we can strip PII from injected doc context before showing to the agent; graphify cannot do this.
- Enterprise line we can draw that Graphify structurally can't: _"on-prem graph + governed hook + streaming guardrails = CISO-compliant code intelligence."_

## Open decisions

1. **Phase 5 in or out?** Ship to external Claude Code users, or storm-CLI-only for now?
2. **Paper/image ingest default behavior:** opt-in per project (recommended — respects budget), or scan-everything-by-default?
3. **Budget ceiling** for initial multi-modal ingest: what's the pause-for-approval threshold? $1? $5? $25?

## Risk log

| Risk                                                      | Likelihood | Mitigation                                                        |
| --------------------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| PDF extraction quality varies wildly by paper layout      | High       | Chunking fallback: pure text extraction if structured parse fails |
| Vision costs spiral on large image sets                   | Medium     | Budget guard with hard ceiling; SVG deterministic path            |
| `pdfjs-dist` bundle bloat                                 | Low        | Lazy-load; papers module only imported when feature enabled       |
| Cross-modal ranking is worse than grep for simple queries | Medium     | Benchmark category: simple bug-fix queries; reveal in Phase 6     |
| Claude Code plugin registry requires review process       | Low        | Ship as direct-install first; registry submission as follow-up    |

## Summary table

| Phase | Scope                   | Effort | Risk   | Gates   |
| ----- | ----------------------- | ------ | ------ | ------- |
| 0     | Wire existing hook      | 1–2d   | Low    | Phase 1 |
| 1     | Docs ingest             | 3–5d   | Low    | Phase 4 |
| 2     | Papers + LLM extraction | 4–6d   | Medium | Phase 4 |
| 3     | Images + vision         | 3–5d   | Medium | Phase 4 |
| 4     | Cross-modal retrieval   | 2–3d   | Low    | Phase 6 |
| 5     | Claude Code plugin      | 2–3d   | Low    | —       |
| 6     | Validation + bench      | 1w     | Low    | Ship    |

**Total:** ~3 weeks of focused Claude-paired work. Phase 0 alone is a 1-day PR that immediately benefits every current storm user.

## Resume checklist (for after restart)

When picking this up in a new session:

1. Read this file: `docs/code-graph-multimodal-plan.md`.
2. Check `packages/hooks/src/builtin/graph-enrich.ts` is still the same shape (the Phase 0 target).
3. Confirm `packages/code-graph/src/index.ts` still exports `CodeGraph` and `indexProject`.
4. Start with Phase 0. Branch name suggestion: `graph-enrich-wire`.
5. Answers to the Open Decisions questions should be captured in a memory or prepended to this file before Phase 5 begins.
