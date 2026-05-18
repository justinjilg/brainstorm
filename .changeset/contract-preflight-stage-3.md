---
"brainstorm": minor
---

Stage-3 contract preflight: a single root-level gate that runs before the build completes and refuses to ship if any surface has drifted. Adopts the BrainstormRouter pattern of compile-time lockstep, applied to every surface this monorepo emits.

Runs 9 gates against built dist + committed source:

- **tool-metadata** — Stage-1 lockstep: every registered built-in tool appears in `BUILTIN_TOOL_METADATA`, no inline/canonical conflicts, no fallback categories, `headlessSafe` explicit.
- **tool-catalog** — `docs/tool-catalog.json` matches source-of-truth.
- **mcp-parity** — every non-deferred tool round-trips through `toMCPTool` with a valid MCP shape.
- **contract-snapshots** — Stage-2 lockstep: every endpoint produces markdown + JSON Schema + validator plan; no empty sections, no missing endpoints.
- **docs-drift** — every endpoint in `PLATFORM_ENDPOINTS` appears as `METHOD /path` in `docs/platform-contract-v1.md`.
- **binary-registry** — every package.json `bin` entry is registered in `BINARY_REGISTRY`, follows the `brainstorm-*` naming pattern (or is grandfathered), points at a real built file, and is unique across the workspace.
- **version-sync** — no internal `@brainst0rm/*` dep points at a stale pin; every published package shares the canonical workspace version (private packages exempt for independent cadence).
- **cli-subcommand-registry** — every `.command()` call in `packages/cli/src/bin/brainstorm.ts` appears in `cli-subcommand-registry.json` with a category.
- **api-route-registry** — every HTTP route in `packages/server/src/server.ts` appears in `api-route-registry.json` with a category.

Wiring:

- Root `npm run build` runs preflight after turbo build. Non-zero exit blocks the workflow.
- CI runs preflight as a required check between build and typecheck.
- Devs reproduce locally with `npm run contract-check` (`--json` for machine-readable output).

Each gate is its own ESM module under `scripts/contract-checks/` exporting `check({ repoRoot })`. Adding a new surface = adding one file and registering it in `scripts/contract-check.mjs`. Tests in `scripts/contract-checks/__tests__/contract-check.test.mjs` assert each gate's API.

First run against `main` caught a real anomaly: `@brainst0rm/image-builder` at `0.1.0-alpha.0` is intentionally off-axis (it ships VM images, not npm packages). The gate now skips `private: true` packages with a comment in the gate explaining the carve-out.
