# Brainstorm Agent Guide

This is the cross-harness operating contract for agents working in this
repository. Product and architecture detail lives in `CLAUDE.md`,
`BRAINSTORM.md`, and `docs/`; this file intentionally stays short.

## Product hierarchy

1. **Kernel:** governed, observable execution across heterogeneous models.
2. **Proving ground:** autonomous software-engineering work.
3. **Destination:** safe AI-managed infrastructure operations.

Prefer changes that improve the kernel's correctness, safety, observability,
verification, or measured quality over adding another surface.

## Repository rules

- Use pnpm 10 and Node 22 or newer.
- Preserve ESM imports with `.js` extensions between TypeScript modules.
- Import across packages through `@brainst0rm/*`; use relative imports only
  inside a package.
- Never bypass tool permissions, workspace scoping, ChangeSets, checkpoints,
  or security middleware.
- Keep model-attempt outcomes distinct from aggregate run outcomes. Routing
  learns per attempt; user-facing surfaces report the aggregate run.
- Scope mutable runtime state by lifecycle: turn, session, background job, or
  process. Do not introduce unscoped module-global session state.
- Extract the agent loop incrementally behind characterized seams. Do not
  perform a big-bang rewrite of `runAgentLoop`.
- Existing and unrelated worktree changes belong to the user. Preserve them.

## Required validation

Run checks in proportion to the touched surface. Before declaring an
iteration complete, the minimum gate is:

```bash
corepack pnpm exec turbo run typecheck test --filter=<changed-package>
pnpm run contract-check
```

Additionally:

- Convert every reproduced live failure into a named regression test.
- Use deterministic artifact verification for correctness; do not treat an
  output substring or a model's self-assessment as proof.
- Keep correctness and efficiency as separate scores.
- Preserve a structured `RunOutcome` for live dogfood evidence.
- Close every independently verified P0/P1 before merging.

## Source-of-truth paths

- Execution outcomes: `packages/shared/src/types.ts`
- Agent loop: `packages/core/src/agent/loop.ts`
- Outcome aggregation: `packages/core/src/agent/loop-outcome.ts`
- Routing learning: `packages/router/src/strategies/learned.ts`
- Evaluation: `packages/eval/`
- Tool catalog: `docs/tool-catalog.json`
- Platform contract: `docs/platform-contract-v1.md`
- Consolidation evidence: `bench/SCOREBOARD.md`

Generated facts must be derived from source or guarded by a contract check.
Historical assessments are evidence, not current architecture documentation.
