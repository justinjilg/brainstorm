---
"brainstorm": minor
---

Stage-4 full lockstep: every artifact-producing path now runs the contract preflight. The protocol is no longer per-surface — every surface that could be locked IS locked, and the gates run on every shipping path (build, CI, release).

New gates (7):

- **tool-name-references** — audits the three hand-maintained tool-name-keyed tables in core (TOOL_CATEGORIES, READ_ONLY_TOOLS, TIER_TOOLS) against BUILTIN_TOOL_METADATA. Caught two real bugs on first run: `notebook_read` was a stale reference (removed), `subagent` is dynamically registered (added to CONDITIONAL_TOOLS allowlist).
- **as-any-budget** — folded from scripts/check-as-any-budget.mjs.
- **ci-soft-fail-budget** — folded from scripts/check-ci-continue-on-error.mjs.
- **dep-cruiser** — folded from scripts/check-dep-cruiser.mjs (no circular imports).
- **abort-signal-lint** — folded from scripts/lint-abort-signal-timeout.mjs.
- **release-flow-wiring** — meta-gate that asserts the preflight is referenced in `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and root `package.json`. Removing the preflight from any artifact-producing workflow now fails the build.
- **docs-field-drift** — extends Stage-2/3's `docs-drift` to enforce field-level alignment. Every Zod-schema field name must appear in the corresponding endpoint's section in `docs/platform-contract-v1.md` (as a markdown table row OR a JSON code-block key).

Release-flow wiring:

- `.github/workflows/release.yml` now runs `node scripts/contract-check.mjs` before the changesets publish step. The npm-publish path can no longer bypass the gate.
- Considered adding `prepublishOnly` to each of 43 publishable packages but chose a single CI gate instead — 43x faster, single point of enforcement, and locked by the release-flow-wiring meta-gate.

Total preflight surface: **16 gates** covering tool metadata, MCP exposure, contract snapshots, docs (both endpoint and field level), binary registry, workspace version sync, CLI subcommands, API routes, and the four legacy ratchets, plus the meta-gate. Adding the 17th gate is a 1-file change.
