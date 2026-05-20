# @brainst0rm/plugin-sdk

## 0.15.0

### Minor Changes

- [#341](https://github.com/justinjilg/brainstorm/pull/341) [`5f17fe7`](https://github.com/justinjilg/brainstorm/commit/5f17fe730afa939dc1e725fca25cddaeddf06c0c) Thanks [@justinjilg](https://github.com/justinjilg)! - Stage-1 of the tool compiler: collocate metadata with tool definitions and collapse the parallel plugin/core tool shapes into one.
  - `BrainstormToolDef` now carries optional `category`, `tags`, `headlessSafe`, and `protocol` metadata fields (formerly hand-maintained in side-tables inside `export-catalog.ts`).
  - New `packages/tools/src/builtin/_metadata.ts` is the canonical metadata source for built-in tools; `export-catalog.ts` reads from it instead of duplicating tables.
  - New `toMCPTool()` generator converts any `BrainstormToolDef` into an MCP registration shape — single function for every "expose a tool over MCP" path.
  - Gate test (`metadata-coverage.test.ts`) fails CI if a registered tool lacks metadata or has the fallback `"other"` category. This is the brainstorm-side equivalent of BR's `_no-inline-routes.test.ts`.
  - `@brainst0rm/plugin-sdk` now depends on `@brainst0rm/tools` and re-exports `defineTool` as `definePluginTool`; `PluginToolDef` is an alias for `BrainstormToolDef`. Existing plugin source continues to compile.

  Refactor caught a real coverage gap: 13 built-in tools (gh_review, gh_actions, gh_release, gh_search, gh_security, gh_repo, memory, the 5 code_graph tools, and pipeline_dispatch) were silently mis-categorized as `"other"` in the old catalog. They now have explicit categories and the gate test prevents regressions.

### Patch Changes

- Updated dependencies [[`5f17fe7`](https://github.com/justinjilg/brainstorm/commit/5f17fe730afa939dc1e725fca25cddaeddf06c0c)]:
  - @brainst0rm/tools@0.15.0
