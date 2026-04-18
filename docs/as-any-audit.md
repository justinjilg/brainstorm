# `as any` audit — 2026-04-18

Follow-up to the v9 stochastic assessment (`docs/assessment-synthesis.md`),
where 8 of 10 agents flagged `as any` count growth as the top consensus
risk. The v8 baseline recorded 274 occurrences; the v9 evidence doc
reported 295; the v9 Auditor re-counted 309. Those three numbers used
different filters, so the first job was to pin a reproducible count.

## Reproducible count (2026-04-18 post-cleanup)

```
grep -rn "as any" packages/ apps/ --include="*.ts" --include="*.tsx" \
  --exclude-dir=node_modules --exclude-dir=dist \
  | grep -v "\.test\." | grep -v "\.spec\."
```

Post-cleanup count: **285**.

The Auditor's 309 included `packages/gateway/node_modules/.pnpm/
fast-copy@4.0.3/...` — vendored third-party code. The evidence doc's
295 missed `.tsx` + missed `--exclude-dir=dist`. The honest count
pre-cleanup was **291**; the v8 baseline (274) and v9 figure (285
after pass 22 cleanup) use the same filter and are directly comparable.
Delta from v8: **+11**, concentrated in reliability-pass type-system
bypass that this audit partially reversed.

## Categorization (top 15 files, 187 of 285 occurrences)

| File                                           | Count | Category                                                                    |
| ---------------------------------------------- | ----- | --------------------------------------------------------------------------- |
| `packages/cli/src/bin/brainstorm.ts`           | 35    | mixed (AI-SDK boundary + CLI option narrowing)                              |
| `packages/db/src/repositories.ts`              | 32    | **DB-row cast** (legitimate escape hatch; better-sqlite3 returns `unknown`) |
| `packages/code-graph/src/graph.ts`             | 18    | tree-sitter node access (external binding, no types)                        |
| `packages/core/src/agent/loop.ts`              | 14    | **AI SDK v6 boundary** (provider-specific fields)                           |
| `packages/code-graph/src/mcp/tools.ts`         | 14    | MCP tool result shape (protocol-level `any`)                                |
| `packages/code-graph/src/vault/obsidian.ts`    | 11    | obsidian plugin API (external)                                              |
| `packages/cli/src/commands/slash.ts`           | 11    | command handler args (mixed)                                                |
| `packages/server/src/server.ts`                | 9     | HTTP payload narrowing                                                      |
| `packages/db/src/team-repository.ts`           | 9     | **DB-row cast** (same class as repositories.ts)                             |
| `packages/vscode/src/extension.ts`             | 7     | VS Code extension API (external)                                            |
| `packages/cli/src/mcp-server.ts`               | 7     | MCP server protocol                                                         |
| `packages/server/src/github-webhook.ts`        | 6     | webhook payload variance                                                    |
| `packages/router/src/strategies/capability.ts` | 6     | model-metadata variance                                                     |
| `apps/desktop/src/App.tsx`                     | 6     | React event typing                                                          |
| `packages/core/src/traceability/store.ts`      | 5     | audit-log shape (mixed)                                                     |

Rough category breakdown:

- **External/boundary (legitimate)**: ~120 (~42%) — AI SDK v6 fields,
  tree-sitter bindings, VS Code API, MCP protocol, DB row shapes,
  webhook payloads. These require types the library doesn't expose
  or types that are genuinely `unknown` at runtime.
- **Narrowing shortcuts**: ~90 (~32%) — should be real type
  predicates or Zod schemas but are currently `x as any`.
- **Lazy/gratuitous**: ~75 (~26%) — Zod-inferred enum already
  matches the target type; cast is dead weight.

## What pass 22 fixed

Removed 6 gratuitous enum casts in `packages/cli/src/bin/brainstorm.ts`
where the config schema's Zod inference already produced the exact
target type:

```ts
// before
configureSandbox(config.shell.sandbox as any, ...)
new PermissionManager(config.general.defaultPermissionMode as any, ...)
router.setStrategy(opts.strategy as any)

// after
configureSandbox(config.shell.sandbox, ...)          // SandboxLevel
new PermissionManager(config.general.defaultPermissionMode, ...)   // PermissionMode
router.setStrategy(opts.strategy as StrategyName)    // Commander gives string
```

291 → 285 with zero typecheck errors, zero test regressions.

The remaining 280 are a mix — roughly half are justified at the
external boundary, a third are lazy narrowing that could become Zod
parse + type predicates, and a quarter are the same pattern (DB-row
access) that should be standardized with a row-interface convention.

## CI gate (ratchet, not target)

`scripts/check-as-any-budget.mjs` fails if the count exceeds **285**.
This is a ratchet — when a PR legitimately reduces the count, the
constant moves down in the same PR. When a PR needs to ADD a new
escape hatch, the constant moves up with a commit message
justifying each new cast. No silent drift.

Wire into CI by calling `node scripts/check-as-any-budget.mjs` from
the same pipeline that runs `pnpm check` / `npx turbo run test`.

## Next moves (not in this pass)

1. **DB-row interfaces** — introduce a `type MessageRow = { id:
string; session_id: string; ... }` per table and replace `.get()
as any` with `.get() as MessageRow` (41 removals across two
   files in one PR).
2. **AI SDK v6 boundary shim** — create a `providerEventShape.ts`
   that narrows AI SDK streaming events with real type guards,
   replacing 14 casts in `loop.ts` with 1–2 centralized ones.
3. **Commander narrowing** — a small `parseEnum<T extends string>()`
   helper replaces `opts.x as T` with `parseEnum(opts.x, VALID_Xs)`,
   which also gives a runtime error instead of `undefined` on a
   typo.

Together these would drop the count to roughly 200; the remaining
80–100 are at genuine external boundaries and worth keeping the
escape hatch for.
