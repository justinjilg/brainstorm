---
"@brainst0rm/godmode": minor
---

Stage-2 of the contract compiler: promote `docs/platform-contract-v1.md` from prose to Zod schemas, generate the markdown spec / JSON Schema / runtime validator / language-binding stubs from one source.

- New `packages/godmode/src/contract/schemas.ts` is the canonical declaration for every platform-contract endpoint (Health, Tool Discovery, Tool Execution, Platform Events, Tenant Lifecycle).
- New `packages/godmode/src/contract/compile.ts` walks the schemas and dispatches each generator. Equivalent role to BR's `scripts/contract-compile.ts`.
- Generators: `markdown` (per-endpoint sections with auto-generated field tables), `json-schema` (Draft 7 bundle with all definitions), `validator` (runtime EndpointCheckPlan consumed by `verifyProductContract`). Pydantic and Go are stubs with TODO markers — the architecture is wired so Stage-2b can fill them in without further plumbing.
- `verifyProductContract` rewired to consume the generated validator. The hand-rolled `validate(body)` callbacks (which only checked top-level field presence) are replaced with `safeParse` against the full schema — so a malformed-but-shape-passing tools list (e.g. missing `risk_level`) now fails the check.
- Snapshot test suite in `src/contract/__tests__/snapshot.test.ts` golden-tests all 5 generator outputs. CI fails on accidental drift; regenerate with `vitest -u` when intended.
- New `npm run compile-contract` script + `--write` mode emits artifacts under `generated/platform-contract/` for inspection.

Behavior change for `brainstorm platform verify <url>`: response-shape failures now surface specific Zod issue paths (`tools.0.risk_level: Required` instead of "Expected array of tools"). Accept-status sets preserved 1:1 with the prior hand-rolled config.
